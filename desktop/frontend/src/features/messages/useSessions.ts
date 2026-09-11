import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import {
  ClearSession,
  CloseSession,
  CreateSession,
  ListSessions,
  PauseSession,
  ResumeSession,
  type SessionSpec,
  type SessionState,
} from "../../lib/bindings";

/**
 * One subscription-session message on the `session:msgs` wire (spec §7.1.3,
 * Go internal/messaging.MsgOut — snake JSON tags are a frozen contract; the
 * type is not generated because events are not part of the bindings surface).
 * Realtime mode arrives as a single-element array, batch mode as up to 500.
 */
export interface MsgOut {
  session_id: string;
  seq: number;
  subject: string;
  headers?: { [key: string]: string[] | null } | null;
  payload_b64: string;
  payload_size: number;
  timestamp: string;
  stream_seq?: number;
  is_utf8: boolean;
}

/**
 * Display cap when the creation spec leaves buffer_size <= 0 ("use the
 * configured default"): mirrors settings.Default() session_buffer_size. The
 * Go side owns the real cap; this only bounds frontend memory per session.
 */
export const DEFAULT_BUFFER = 10000;

/** The useSessions surface consumed by SessionsPanel / SessionView. */
export interface SessionsApi {
  sessions: SessionState[];
  messages: Record<string, MsgOut[]>;
  create: (spec: SessionSpec) => Promise<SessionState | null>;
  pause: (id: string) => void;
  resume: (id: string) => void;
  clear: (id: string) => void;
  close: (id: string) => void;
}

const byId = (a: SessionState, b: SessionState) => a.id.localeCompare(b.id);

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Frontend state for the subscription sessions tab (spec §6.4). Hydrates the
 * session list from ListSessions(), then keeps it live via the Wails events:
 * `session:msgs` appends batches per session (dropping the oldest beyond the
 * per-session buffer cap) and `session:state` upserts status snapshots.
 *
 * Pause/resume/clear/close apply their state change locally first (§18.5
 * click-to-feedback under 100ms — the throttled session:state event would be
 * far too slow), then fire the binding; a failed call toasts and re-syncs
 * from the manager's list.
 */
export function useSessions(): SessionsApi {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [messages, setMessages] = useState<Record<string, MsgOut[]>>({});
  // Per-session display cap, remembered from each create() spec (<= 0 means
  // the server resolved the configured default → DEFAULT_BUFFER here).
  const caps = useRef<Record<string, number>>({});

  const upsert = useCallback((st: SessionState) => {
    if (!st || typeof st.id !== "string") return;
    setSessions((prev) => {
      const next = prev.some((s) => s.id === st.id)
        ? prev.map((s) => (s.id === st.id ? { ...s, ...st } : s))
        : [...prev, { ...st }];
      return next.sort(byId);
    });
  }, []);

  useEffect(() => {
    let alive = true;

    const offMsgs = Events.On("session:msgs", (e: { data?: unknown }) => {
      const batch = Array.isArray(e?.data) ? (e.data as MsgOut[]) : [];
      if (batch.length === 0) return;
      setMessages((prev) => {
        const next = { ...prev };
        for (const m of batch) {
          if (!m || typeof m.session_id !== "string") continue;
          const cap = caps.current[m.session_id] ?? DEFAULT_BUFFER;
          const list = next[m.session_id] ? [...next[m.session_id], m] : [m];
          next[m.session_id] = list.length > cap ? list.slice(list.length - cap) : list;
        }
        return next;
      });
    });

    const offState = Events.On("session:state", (e: { data?: unknown }) => {
      upsert(e?.data as SessionState);
    });

    // Hydrate sessions that existed before this panel mounted (including
    // closed ones). Generated binding may resolve null — never map over it.
    ListSessions()
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        setSessions((prev) => {
          const seen = new Map(prev.map((s) => [s.id, s]));
          for (const s of list) if (s && typeof s.id === "string") seen.set(s.id, s);
          return [...seen.values()].sort(byId);
        });
      })
      .catch(() => {
        /* outside Wails (tests/plain browser) — the event stream drives */
      });

    return () => {
      alive = false;
      offMsgs();
      offState();
    };
  }, [upsert]);

  /** Re-sync from the manager after a failed control call (optimistic local
   * state may be wrong; the snapshot is the source of truth). */
  const resync = useCallback(() => {
    ListSessions()
      .then((list) => {
        if (!Array.isArray(list)) return;
        setSessions((prev) => {
          const seen = new Map(prev.map((s) => [s.id, s]));
          for (const s of list) if (s && typeof s.id === "string") seen.set(s.id, s);
          return [...seen.values()].sort(byId);
        });
      })
      .catch(() => {});
  }, []);

  const create = useCallback(
    async (spec: SessionSpec): Promise<SessionState | null> => {
      try {
        const st = await CreateSession(spec);
        caps.current[st.id] = spec.buffer_size > 0 ? spec.buffer_size : DEFAULT_BUFFER;
        upsert(st);
        return st;
      } catch (err) {
        toast.error(t("messages.sessions.createFailed", { error: errText(err) }));
        return null;
      }
    },
    [t, upsert],
  );

  const pause = useCallback(
    (id: string) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "paused" } : s)));
      PauseSession(id).catch((err) => {
        toast.error(t("messages.sessions.actionFailed", { error: errText(err) }));
        resync();
      });
    },
    [t, resync],
  );

  const resume = useCallback(
    (id: string) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "running" } : s)));
      ResumeSession(id).catch((err) => {
        toast.error(t("messages.sessions.actionFailed", { error: errText(err) }));
        resync();
      });
    },
    [t, resync],
  );

  const clear = useCallback(
    (id: string) => {
      setMessages((prev) => ({ ...prev, [id]: [] }));
      ClearSession(id).catch((err) => {
        toast.error(t("messages.sessions.actionFailed", { error: errText(err) }));
        resync();
      });
    },
    [t, resync],
  );

  const close = useCallback(
    (id: string) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "closed" } : s)));
      CloseSession(id).catch((err) => {
        toast.error(t("messages.sessions.actionFailed", { error: errText(err) }));
        resync();
      });
    },
    [t, resync],
  );

  return { sessions, messages, create, pause, resume, clear, close };
}
