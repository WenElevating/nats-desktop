import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import {
  ClearSession,
  CloseSession,
  CreateSession,
  DataChannel,
  ListSessions,
  PauseSession,
  ResumeSession,
  type SessionSpec,
  type SessionState,
} from "../../lib/bindings";
import { connectMsgChannel, type MsgChannel } from "@/lib/msgChannel";
import { applyPendingMsgs, applyStateUpsert, byId, DEFAULT_BUFFER, type MsgOut } from "./sessionsLogic";

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
 * Flush scheduler seam. The default schedules one animation frame per flush
 * (requestAnimationFrame, ≤16ms setTimeout fallback for non-browser hosts).
 * Tests inject a manual/synchronous scheduler for determinism.
 */
export type FlushScheduler = (cb: () => void) => () => void;

export const rafFlushScheduler: FlushScheduler = (cb) => {
  if (typeof requestAnimationFrame === "function") {
    const h = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(h);
  }
  const h = window.setTimeout(cb, 16);
  return () => window.clearTimeout(h);
};

/**
 * Pending-buffer high water: a session's buffered messages are trimmed to its
 * display cap once they exceed 2× cap, so a long hidden/unflushed spell (the
 * flush is paused while document.hidden) cannot grow the buffer without
 * bound. Trimming beyond cap is lossless: the fold keeps only the newest cap
 * per session anyway, so the dropped prefix would never reach the display.
 */
const HIGH_WATER_FACTOR = 2;

/**
 * Frontend state for the subscription sessions tab (spec §6.4). Hydrates the
 * session list from ListSessions(), then keeps it live: `session:msgs`
 * batches arrive over the loopback WS data-plane channel (DataChannel binding
 * + connectMsgChannel, m6-perf §12.3; dropping the oldest beyond the
 * per-session buffer cap) while `session:state` upserts status snapshots via
 * wails events (control plane).
 *
 * M6 Task 8 — realtime-push coalescing: at 1k msg/s realtime mode delivers
 * one Wails event per message; feeding each straight into setState re-rendered
 * the list ~1000×/s and drove the renderer to ~1.4GB (Task 5 measurement).
 * Events now land in refs (never setState per event) and ONE flush per
 * animation frame folds everything buffered into React state — while
 * document.hidden the flush is paused entirely (visibilitychange resumes it).
 * §6.4 semantics are preserved: messages appear in arrival order, the newest
 * per-session cap is kept exactly, and counters come from the latest
 * `session:state` snapshot (last-writer-wins within one frame is
 * indistinguishable from rendering every intermediate snapshot).
 *
 * Pause/resume/clear/close apply their state change locally first (§18.5
 * click-to-feedback under 100ms — the throttled session:state event would be
 * far too slow), then fire the binding; a failed call toasts and re-syncs
 * from the manager's list.
 */
export function useSessions(options?: { scheduler?: FlushScheduler }): SessionsApi {
  const { t } = useTranslation();
  const schedule = options?.scheduler ?? rafFlushScheduler;
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [messages, setMessages] = useState<Record<string, MsgOut[]>>({});
  // Per-session display cap, remembered from each create() spec (<= 0 means
  // the server resolved the configured default → DEFAULT_BUFFER here).
  const caps = useRef<Record<string, number>>({});

  // --- Coalescing buffers (refs; mutated from event handlers and the flush,
  // never from setState updaters which StrictMode double-invokes). ---
  const pendingMsgs = useRef<Record<string, MsgOut[]>>({});
  const pendingStates = useRef<Map<string, SessionState>>(new Map());
  const cancelFlush = useRef<(() => void) | null>(null);

  const runFlush = useCallback(() => {
    cancelFlush.current = null;
    const msgs = pendingMsgs.current;
    const states = pendingStates.current;
    pendingMsgs.current = {};
    pendingStates.current = new Map();
    if (Object.keys(msgs).length > 0) {
      setMessages((prev) => applyPendingMsgs(prev, msgs, caps.current));
    }
    if (states.size > 0) {
      setSessions((prev) => {
        let next = prev;
        for (const st of states.values()) next = applyStateUpsert(next, st);
        return next;
      });
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (cancelFlush.current !== null) return; // one flush already scheduled
    // Hidden → paused: buffers keep accumulating (bounded by the high-water
    // trim); visibilitychange re-schedules the flush.
    if (typeof document !== "undefined" && document.hidden) return;
    cancelFlush.current = schedule(runFlush);
  }, [schedule, runFlush]);

  /** Fold one wire batch into the pending buffer (per-session arrival order,
   * high-water trim per session). O(batch) — no per-message state churn. */
  const bufferMsgs = useCallback((batch: unknown) => {
    if (!Array.isArray(batch) || batch.length === 0) return;
    for (const m of batch as MsgOut[]) {
      if (!m || typeof m.session_id !== "string") continue;
      const list = pendingMsgs.current[m.session_id];
      if (list) list.push(m);
      else pendingMsgs.current[m.session_id] = [m];
    }
    // Trim after the whole batch so one oversized batch cannot straddle.
    for (const sid of Object.keys(pendingMsgs.current)) {
      const list = pendingMsgs.current[sid];
      const cap = caps.current[sid] ?? DEFAULT_BUFFER;
      if (list.length >= cap * HIGH_WATER_FACTOR) {
        pendingMsgs.current[sid] = list.slice(list.length - cap);
      }
    }
  }, []);

  const upsert = useCallback((st: SessionState) => {
    setSessions((prev) => applyStateUpsert(prev, st));
  }, []);

  useEffect(() => {
    let alive = true;

    // Data plane (m6-perf §12.3): §7.1.3 batches ride the loopback WS
    // channel; the wails event path no longer carries message batches.
    // session:state below remains a wails event (control plane).
    // DataChannel() is a $CancellablePromise like every binding — resolve
    // it; do NOT treat it as synchronous.
    let channel: MsgChannel | null = null;
    DataChannel()
      .then((dc) => {
        if (!alive || !dc?.url || !dc?.token) return;
        channel = connectMsgChannel(dc.url, dc.token, (data) => {
          bufferMsgs(data);
          scheduleFlush();
        });
      })
      .catch(() => {
        /* endpoint unavailable: live frames pause; counters keep flowing
           via session:state and §6.4's no-replay-on-resume covers the UI */
      });

    const offState = Events.On("session:state", (e: { data?: unknown }) => {
      const st = e?.data as SessionState;
      if (st && typeof st.id === "string") {
        pendingStates.current.set(st.id, st); // last snapshot wins per frame
        scheduleFlush();
      }
    });

    // Resume the paused flush when the window becomes visible again.
    const onVisibility = () => {
      if (!document.hidden) scheduleFlush();
    };
    document.addEventListener("visibilitychange", onVisibility);

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
      channel?.close();
      offState();
      document.removeEventListener("visibilitychange", onVisibility);
      if (cancelFlush.current) {
        cancelFlush.current();
        cancelFlush.current = null;
      }
    };
  }, [bufferMsgs, scheduleFlush]);

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
      // Drop the session's not-yet-flushed messages too, or the next frame
      // would fold the pre-clear backlog back over the cleared list.
      delete pendingMsgs.current[id];
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
