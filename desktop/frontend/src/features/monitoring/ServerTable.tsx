import { useMemo, useRef, useState, type AriaAttributes } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "../../app/i18n";
import type { MonitorServerRow, MonitorSnapshot } from "../../lib/bindings";
import { formatBytes } from "../messages/schema";
import { Badge } from "@/components/ui/badge";

// Fixed-equal rows (28px, overscan 8) so a large fleet costs O(viewport),
// mirroring StreamList/messages. Header and body are BOTH plain grid rows
// sharing the single GRID_COLS template below (same px-3, no track gap), so
// their columns cannot drift. The fixed tracks sum to 528px inside the
// full-width page; the name column takes the rest (minmax(0,1fr)).
const ROW_HEIGHT = 28;
const OVERSCAN = 8;

/**
 * Column template shared by the header row and the virtual row grid (one
 * source of truth; exported for a layout regression test): status dot, name,
 * version, uptime, cpu, memory, connections, routes/gateways, JS role.
 */
export const GRID_COLS =
  "grid-cols-[40px_minmax(0,1fr)_72px_80px_56px_72px_56px_64px_88px]";

export interface ServerTableProps {
  snapshot: MonitorSnapshot | null;
  /** Selected server NAME. */
  selected: string | null;
  onSelect: (name: string) => void;
}

type SortKey =
  | "name"
  | "version"
  | "uptime"
  | "cpu"
  | "mem"
  | "connections"
  | "routes";

interface SortState {
  key: SortKey;
  desc: boolean;
}

/** Uptime cell: seconds reduced to a compact d/h/m/s form, 0 → "—". Shared
 * with the NodeDetail report card. */
export function formatUptime(seconds: number): string {
  if (seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

const byKey = (a: MonitorServerRow, b: MonitorServerRow, key: SortKey): number => {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "version":
      return a.version.localeCompare(b.version);
    case "uptime":
      return a.uptime_seconds - b.uptime_seconds;
    case "cpu":
      return a.cpu - b.cpu;
    case "mem":
      return a.mem_bytes - b.mem_bytes;
    case "connections":
      return a.connections - b.connections;
    case "routes":
      return a.routes - b.routes || a.gateways - b.gateways;
  }
};

/**
 * Virtualized server table (spec §6.10 / brief): grid header sharing one
 * column template with the virtual rows, client-side sorting, the green/red
 * status dot, humanized memory and monospaced numeric cells (§18.2), the JS
 * role badge (meta_leader highlighted), and offline rows dimmed with a red
 * dot and the failure原文 as the row title.
 */
export function ServerTable({ snapshot, selected, onSelect }: ServerTableProps) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<SortState>({ key: "name", desc: false });
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = snapshot?.servers ?? [];

  const sorted = useMemo(() => {
    const arr = [...rows];
    const dir = sort.desc ? -1 : 1;
    arr.sort((a, b) => byKey(a, b, sort.key) * dir);
    return arr;
  }, [snapshot, sort]);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false }));

  const sortLabel = (key: SortKey) =>
    t(`monitor.col.${key === "connections" ? "conns" : key}`);

  /** Sortable header cell: button + aria-sort for the active column. */
  const sortHead = (key: SortKey, align?: "right") => ({
    "aria-sort": (sort.key === key
      ? sort.desc
        ? "descending"
        : "ascending"
      : undefined) as AriaAttributes["aria-sort"],
    "data-testid": `monitor-col-${key}`,
    className:
      align === "right"
        ? "min-w-0 overflow-hidden whitespace-nowrap text-right"
        : "min-w-0 overflow-hidden whitespace-nowrap",
    children: (
      <button
        type="button"
        data-testid={`monitor-sort-${key}`}
        onClick={() => toggleSort(key)}
        className="flex items-center gap-0.5 text-xs font-medium text-[var(--fg-muted)] hover:text-foreground"
      >
        {sortLabel(key)}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    ),
  });

  /** JS role badge: meta_leader highlighted (§6.10 Global 12 mapping). */
  const roleCell = (r: MonitorServerRow) => {
    if (!r.js_enabled) {
      return (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {t("monitor.role.disabled")}
        </Badge>
      );
    }
    if (r.js_role === "meta_leader") {
      return (
        <Badge
          data-testid="monitor-role-leader"
          className="bg-[var(--accent-soft)] px-1.5 py-0 text-[10px] text-[var(--accent-strong)]"
        >
          {t("monitor.role.metaLeader")}
        </Badge>
      );
    }
    if (r.js_role === "voter") {
      return (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {t("monitor.role.voter")}
        </Badge>
      );
    }
    return <span className="text-[var(--fg-muted)]">{t("monitor.role.unknown")}</span>;
  };

  return (
    // data-polled-at is the Task 14 UIA anchor for the two-cycle refresh
    // assertion (mirrored on the MonitoringPage root).
    <div
      data-testid="monitor-table"
      role="table"
      data-polled-at={snapshot?.polled_at_ms ?? 0}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Plain grid row sharing GRID_COLS with the virtual body rows — no
          <table>, no separate overflow context, so columns stay aligned. */}
      <div
        role="row"
        data-testid="monitor-table-header"
        className={`grid h-8 shrink-0 items-center border-b border-border text-xs ${GRID_COLS} px-3`}
      >
        <div role="columnheader" className="min-w-0 overflow-hidden whitespace-nowrap" />
        <div role="columnheader" {...sortHead("name")} />
        <div role="columnheader" {...sortHead("version")} />
        <div role="columnheader" {...sortHead("uptime", "right")} />
        <div role="columnheader" {...sortHead("cpu", "right")} />
        <div role="columnheader" {...sortHead("mem", "right")} />
        <div role="columnheader" {...sortHead("connections", "right")} />
        <div role="columnheader" {...sortHead("routes", "right")} />
        <div
          role="columnheader"
          className="min-w-0 overflow-hidden whitespace-nowrap text-right"
        >
          {t("monitor.col.role")}
        </div>
      </div>
      {sorted.length === 0 ? (
        <p data-testid="monitor-table-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("monitor.empty")}
        </p>
      ) : (
        <div
          ref={parentRef}
          data-testid="monitor-list"
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const r = sorted[vi.index];
              if (!r) return null;
              const offline = !r.online;
              return (
                <div
                  key={vi.key}
                  data-testid={`monitor-row-${r.name}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === r.name}
                  data-offline={String(offline)}
                  title={offline ? r.error : undefined}
                  onClick={() => onSelect(r.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect(r.name);
                  }}
                  className={`absolute left-0 grid ${GRID_COLS} w-full cursor-pointer items-center px-3 text-xs hover:bg-[var(--accent-soft)] ${
                    selected === r.name ? "bg-[var(--accent-soft)]" : ""
                  } ${offline ? "opacity-60" : ""}`}
                  style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="flex min-w-0 items-center">
                    <span
                      data-testid={offline ? "monitor-offline-dot" : "monitor-online-dot"}
                      title={offline ? t("monitor.offline") : t("monitor.online")}
                      aria-label={offline ? t("monitor.offline") : t("monitor.online")}
                      className={`size-2 shrink-0 rounded-full ${
                        offline ? "bg-[var(--danger)]" : "bg-[var(--ok)]"
                      }`}
                    />
                  </span>
                  <span className="truncate font-medium" title={`${r.name} · ${r.host}`}>
                    {r.name}
                  </span>
                  <span className="truncate text-[var(--fg-muted)]">{r.version || "—"}</span>
                  <span className="text-right font-mono tabular-nums">
                    {formatUptime(r.uptime_seconds)}
                  </span>
                  <span className="text-right font-mono tabular-nums">
                    {r.online ? `${r.cpu.toFixed(1)}%` : "—"}
                  </span>
                  <span className="text-right font-mono tabular-nums">
                    {r.online ? formatBytes(r.mem_bytes) : "—"}
                  </span>
                  <span className="text-right font-mono tabular-nums">{r.connections}</span>
                  <span className="text-right font-mono tabular-nums">
                    {r.routes}/{r.gateways}
                  </span>
                  <span
                    data-testid={`monitor-role-${r.name}`}
                    className="flex min-w-0 items-center justify-end"
                  >
                    {roleCell(r)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
