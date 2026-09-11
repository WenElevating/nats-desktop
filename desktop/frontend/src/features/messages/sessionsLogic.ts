/**
 * Pure state-transition logic for the subscription-sessions tab (spec §6.4).
 * Extracted from useSessions (Task 11) so the hot ingest path is
 * unit-testable and benchmarkable without React or a NATS server; the hook
 * applies these functions via setState updaters, so behavior is unchanged
 * (the messages-sessions suite exercises the hook end-to-end).
 */
import type { SessionState } from "../../lib/bindings";

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

export const byId = (a: SessionState, b: SessionState) => a.id.localeCompare(b.id);

/**
 * applyMsgsBatch folds one `session:msgs` batch (unknown payload shape — it
 * crosses the Wails event bridge) into the per-session message lists, keeping
 * at most the per-session cap (default DEFAULT_BUFFER) newest messages per
 * session. Returns prev unchanged for a non-array/empty batch, so React bails
 * out of the re-render exactly like the previous early return.
 */
export function applyMsgsBatch(
  prev: Record<string, MsgOut[]>,
  batch: unknown,
  caps: Record<string, number>,
): Record<string, MsgOut[]> {
  if (!Array.isArray(batch) || batch.length === 0) return prev;
  const next = { ...prev };
  for (const m of batch as MsgOut[]) {
    if (!m || typeof m.session_id !== "string") continue;
    const cap = caps[m.session_id] ?? DEFAULT_BUFFER;
    const list = next[m.session_id] ? [...next[m.session_id], m] : [m];
    next[m.session_id] = list.length > cap ? list.slice(list.length - cap) : list;
  }
  return next;
}

/**
 * applyStateUpsert upserts one `session:state` snapshot into the sorted
 * session list (insert-or-merge, sorted by id). Returns prev unchanged for a
 * malformed snapshot.
 */
export function applyStateUpsert(prev: SessionState[], st: SessionState): SessionState[] {
  if (!st || typeof st.id !== "string") return prev;
  const next = prev.some((s) => s.id === st.id)
    ? prev.map((s) => (s.id === st.id ? { ...s, ...st } : s))
    : [...prev, { ...st }];
  return next.sort(byId);
}
