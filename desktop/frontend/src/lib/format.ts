/**
 * Shared formatting helpers (M6 Task 8 ㉔) — the app's single byte formatter.
 * Previously three implementations coexisted (the messages-page MiB-capped
 * copy, NodeDetail's local formatSize, DashboardPage's local formatSize); all
 * call sites now render through this one B→TiB ladder.
 */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export type ByteUnit = (typeof UNITS)[number];

export interface FormatBytesOptions {
  /** Ladder ceiling (default "TiB"): values beyond it stay expressed in the
   * max unit instead of overflowing to "1024.0 TiB"-style strings. */
  maxUnit?: ByteUnit;
}

/**
 * Human byte size on the IEC ladder (B → KiB → MiB → GiB → TiB):
 * whole bytes render bare ("0 B" / "16 B"), one decimal below 10 of a unit
 * ("2.0 KiB" / "9.0 MiB"), none above ("16 KiB" / "118 MiB"); GiB/TiB keep
 * one decimal ("1.0 GiB") since capacity values are read at a glance.
 * Negatives and non-finite input never render — they collapse to "0 B"
 * (unlimited/-1 sentinels are resolved by callers before formatting).
 */
export function formatBytes(n: number, opts: FormatBytesOptions = {}): string {
  const maxIdx = UNITS.indexOf(opts.maxUnit ?? "TiB");
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let value = n;
  let idx = 0;
  while (idx < maxIdx && value >= 1024) {
    value /= 1024;
    idx++;
  }
  if (idx === 0) return `${Math.round(value)} B`;
  const decimals = idx >= 3 || value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${UNITS[idx]}`;
}
