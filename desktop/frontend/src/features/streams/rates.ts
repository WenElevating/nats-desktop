/**
 * Message-rate sampling for the Streams page (spec §6.6), pure logic with no
 * React or binding dependencies so it is unit-testable in isolation.
 *
 * Two layers:
 * - RateSampler: a per-stream rolling sample buffer fed from stream-detail
 *   polls. Rate is ΔLastSeq/Δt with natscli calculateRate parity: a zero or
 *   negative delta (idle stream / purge / delete wraparound) HOLDS the last
 *   rate instead of dropping to zero, so the display does not flicker.
 * - computeListRates: the same idea applied to consecutive ListStreams
 *   snapshots for the list's rate column. Streams without history are absent
 *   from the result (the caller renders "—").
 */

/** One observation of a stream's sequence counters at time `t` (ms). */
export interface Sample {
  t: number;
  lastSeq: number;
  firstSeq: number;
}

/**
 * Retention window. The detail view's largest series window is 1h; samples
 * older than 1h (measured against the newest sample) are dropped on push.
 */
const MAX_WINDOW_MS = 3_600_000;
/** Hard capacity cap so a long-running session cannot leak memory. */
const MAX_SAMPLES = 4_000;

export class RateSampler {
  private samples: Sample[] = [];
  private lastRate = NaN;

  /** Appends a sample and prunes everything outside the retention window
   * (and beyond the capacity cap) relative to it. */
  push(s: Sample): void {
    this.samples.push(s);
    const cutoff = s.t - MAX_WINDOW_MS;
    let start = 0;
    while (start < this.samples.length && this.samples[start].t < cutoff) start++;
    if (start > 0) this.samples.splice(0, start);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
  }

  /**
   * msg/s over the newest sample pair. Fewer than two samples → NaN (first
   * frame). Δ ≤ 0 or Δt ≤ 0 keeps the previous value (hold-last-on-zero /
   * purge wraparound), otherwise the rate is recomputed. A newest sample
   * older than the retention window relative to the caller's `now` means
   * sampling has stalled — the held rate is no longer meaningful → NaN.
   */
  rate(now: number): number {
    const n = this.samples.length;
    if (n < 2) return NaN;
    const last = this.samples[n - 1];
    if (now - last.t > MAX_WINDOW_MS) return NaN;
    const prev = this.samples[n - 2];
    const dtSec = (last.t - prev.t) / 1000;
    const delta = last.lastSeq - prev.lastSeq;
    if (dtSec > 0 && delta > 0) this.lastRate = delta / dtSec;
    return this.lastRate;
  }

  /**
   * Buckets [now - windowMs, now] into `buckets` points; each point is the
   * msg/s observed between consecutive samples inside that bucket (0 when a
   * bucket has no usable pair, never negative).
   */
  series(windowMs: number, now: number, buckets: number): number[] {
    const out = new Array<number>(Math.max(0, buckets)).fill(0);
    if (out.length === 0 || windowMs <= 0) return out;
    const start = now - windowMs;
    const bucketMs = windowMs / out.length;
    let prev: Sample | null = null;
    let prevIdx = -1;
    for (const s of this.samples) {
      if (s.t < start || s.t > now) continue;
      const raw = Math.floor((s.t - start) / bucketMs);
      const idx = Math.min(out.length - 1, Math.max(0, raw));
      if (prev !== null && idx === prevIdx) {
        const dtSec = (s.t - prev.t) / 1000;
        const delta = s.lastSeq - prev.lastSeq;
        if (dtSec > 0 && delta > 0) out[idx] = delta / dtSec;
      }
      prev = s;
      prevIdx = idx;
    }
    return out;
  }

  /** Number of retained samples (exposed for tests / diagnostics). */
  count(): number {
    return this.samples.length;
  }

  /** Drops all history (used when the selected stream changes). */
  reset(): void {
    this.samples = [];
    this.lastRate = NaN;
  }
}

/**
 * Per-stream rates for one list refresh: ΔLastSeq/Δt between the previous
 * snapshot and the current one. Streams with no previous snapshot are absent
 * (caller renders "—"); dtMs ≤ 0 yields an empty map (no division by zero).
 * Unlike RateSampler this does NOT hold the last value — the list recomputes
 * from snapshots each time, so an idle stream reports 0.
 */
export function computeListRates(
  prev: Map<string, StreamSummaryLike>,
  cur: StreamSummaryLike[],
  dtMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (dtMs <= 0) return out;
  const secs = dtMs / 1000;
  for (const s of cur) {
    const p = prev.get(s.name);
    if (!p) continue;
    out.set(s.name, (s.last_seq - p.last_seq) / secs);
  }
  return out;
}

/** Structural subset of the generated StreamSummary the math depends on. */
interface StreamSummaryLike {
  name: string;
  last_seq: number;
}

/**
 * Display formatting for a sampled rate: whole rates unformatted, fractional
 * to one decimal (natscli-style). NaN (no history yet) renders as "—".
 */
export function formatRate(rate: number): string {
  if (Number.isNaN(rate)) return "—";
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
}
