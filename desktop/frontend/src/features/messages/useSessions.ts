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
import { applyMsgsBatch, applyStateUpsert, byId, DEFAULT_BUFFER, type MsgOut } from "./sessionsLogic";

// The wire type and display cap live in sessionsLogic.ts (pure state machine,
// benchmarked in Task 11); re-exported here for the existing import surface.
export { DEFAULT_BUFFER } from "./sessionsLogic";
export type { MsgOut };

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
    setSessions((prev) => applyStateUpsert(prev, st));
  }, []);

  useEffect(() => {
    let alive = true;

    const offMsgs = Events.On("session:msgs", (e: { data?: unknown }) => {
      setMessages((prev) => applyMsgsBatch(prev, e?.data, caps.current));
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
