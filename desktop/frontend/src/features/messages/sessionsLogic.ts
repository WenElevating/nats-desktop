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
 *
 * The batch is grouped per session and appended with ONE concat per session
 * (O(prevLen + batchLen)) instead of one array copy per message — the M6 Task
 * 8 memory wave: the old per-message spread was O(batch × listLen) and churned
 * a fresh 10k-element array per message at flood rates. Output is identical.
 */
export function applyMsgsBatch(
  prev: Record<string, MsgOut[]>,
  batch: unknown,
  caps: Record<string, number>,
): Record<string, MsgOut[]> {
  if (!Array.isArray(batch) || batch.length === 0) return prev;
  const grouped: Record<string, MsgOut[]> = {};
  for (const m of batch as MsgOut[]) {
    if (!m || typeof m.session_id !== "string") continue;
    (grouped[m.session_id] ??= []).push(m);
  }
  return applyPendingMsgs(prev, grouped, caps);
}

/**
 * applyPendingMsgs folds already-validated per-session pending lists (the
 * Task 8 coalescing buffer — many `session:msgs` events accumulated between
 * animation frames) into the per-session message lists. Same newest-cap
 * semantics as applyMsgsBatch; per-session order is the arrival order.
 */
export function applyPendingMsgs(
  prev: Record<string, MsgOut[]>,
  pending: Record<string, MsgOut[]>,
  caps: Record<string, number>,
): Record<string, MsgOut[]> {
  let next: Record<string, MsgOut[]> | null = null;
  for (const sid of Object.keys(pending)) {
    const batch = pending[sid];
    if (!Array.isArray(batch) || batch.length === 0) continue;
    next ??= { ...prev };
    const cap = caps[sid] ?? DEFAULT_BUFFER;
    const merged = next[sid] ? [...next[sid], ...batch] : batch;
    next[sid] = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  }
  return next ?? prev;
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
