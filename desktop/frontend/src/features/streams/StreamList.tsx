import { useMemo, useRef, useState, type AriaAttributes } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "../../app/i18n";
import type { StreamSummary } from "../../lib/bindings";
import { formatBytes } from "../messages/schema";
import { formatRate } from "./rates";
import { Badge } from "@/components/ui/badge";
import { Table, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Fixed-equal rows (28px, overscan 8) so a 10k-stream list costs O(viewport),
// mirroring the messages list. The header is a shadcn Table (table-fixed);
// the virtual body is an absolutely-positioned row grid sharing the same
// column template, so header and rows stay aligned.
const ROW_HEIGHT = 28;
const OVERSCAN = 8;

/** Column template shared by the table header and the virtual row grid. */
const GRID_COLS =
  "grid-cols-[minmax(0,1fr)_150px_64px_76px_72px_64px_120px_56px]";

export interface StreamListProps {
  streams: StreamSummary[];
  /** name → msg/s from the latest list refresh; missing entry renders "—". */
  rates?: Map<string, number>;
  selected: string | null;
  onSelect: (name: string) => void;
}

type SortKey = "name" | "messages" | "bytes" | "last_time";

interface SortState {
  key: SortKey;
  desc: boolean;
}

/** "Last time" cell: ms epoch reduced to a local date-time, 0 → "—". */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

/**
 * Virtualized stream table (spec §6.6): shadcn table header with client-side
 * sorting (name/messages/bytes/last_time), KV/object + mirror badges, the
 * rate column fed by computeListRates, and a red replica marker when the
 * stream reports unhealthy replicas. Rows are @tanstack/react-virtual items.
 */
export function StreamList({ streams, rates, selected, onSelect }: StreamListProps) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<SortState>({ key: "name", desc: false });
  const parentRef = useRef<HTMLDivElement>(null);

  /** Rate cell: no history (undefined/NaN) renders the bare "—" placeholder,
   * never "— msg/s". */
  const rateCell = (r: number | undefined): string =>
    r === undefined || Number.isNaN(r)
      ? t("streams.noData")
      : t("streams.rate", { rate: formatRate(r) });

  const sorted = useMemo(() => {
    const arr = [...streams];
    const dir = sort.desc ? -1 : 1;
    arr.sort((a, b) => {
      switch (sort.key) {
        case "name":
          return a.name.localeCompare(b.name) * dir;
        case "messages":
          return (a.messages - b.messages) * dir;
        case "bytes":
          return (a.bytes - b.bytes) * dir;
        case "last_time":
          return (a.last_time_ms - b.last_time_ms) * dir;
      }
    });
    return arr;
  }, [streams, sort]);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false }));

  const sortLabel = (key: SortKey) =>
    t(`streams.col.${key === "last_time" ? "lastTime" : key}`);

  /** Sortable header cell: button + aria-sort for the active column. */
  const sortHead = (key: SortKey) => ({
    "aria-sort": (sort.key === key
      ? sort.desc
        ? "descending"
        : "ascending"
      : undefined) as AriaAttributes["aria-sort"],
    children: (
      <button
        type="button"
        data-testid={`stream-sort-${key}`}
        onClick={() => toggleSort(key)}
        className="flex items-center gap-0.5 text-xs font-medium text-[var(--fg-muted)] hover:text-foreground"
      >
        {sortLabel(key)}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    ),
  });

  return (
    <div data-testid="streams-table" className="flex min-h-0 flex-1 flex-col">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-8 px-3" {...sortHead("name")} />
            <TableHead className="h-8 w-[150px] px-2 text-xs">{t("streams.col.subjects")}</TableHead>
            <TableHead className="h-8 w-[64px] px-2 text-right" {...sortHead("messages")} />
            <TableHead className="h-8 w-[76px] px-2 text-right text-xs">{t("streams.col.rate")}</TableHead>
            <TableHead className="h-8 w-[72px] px-2 text-right" {...sortHead("bytes")} />
            <TableHead className="h-8 w-[64px] px-2 text-right text-xs">{t("streams.col.consumers")}</TableHead>
            <TableHead className="h-8 w-[120px] px-2" {...sortHead("last_time")} />
            <TableHead className="h-8 w-[56px] px-2 text-right text-xs">{t("streams.col.replicas")}</TableHead>
          </TableRow>
        </TableHeader>
      </Table>
      {sorted.length === 0 ? (
        <p data-testid="streams-list-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("streams.listEmpty")}
        </p>
      ) : (
        <div
          ref={parentRef}
          data-testid="streams-list"
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const s = sorted[vi.index];
              if (!s) return null;
              const unhealthy = s.unhealthy_replicas > 0;
              return (
                <div
                  key={vi.key}
                  data-testid={`stream-row-${s.name}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === s.name}
                  onClick={() => onSelect(s.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect(s.name);
                  }}
                  className={`absolute left-0 ${GRID_COLS} w-full cursor-pointer items-center gap-2 px-3 text-xs hover:bg-[var(--accent-soft)] ${
                    selected === s.name ? "bg-[var(--accent-soft)]" : ""
                  }`}
                  style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{s.name}</span>
                    {s.internal_kind === "kv" && (
                      <Badge
                        variant="outline"
                        data-testid={`stream-kind-${s.name}`}
                        className="shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        {t("streams.kindKv")}
                      </Badge>
                    )}
                    {s.internal_kind === "object" && (
                      <Badge
                        variant="outline"
                        data-testid={`stream-kind-${s.name}`}
                        className="shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        {t("streams.kindObject")}
                      </Badge>
                    )}
                    {s.is_mirror && (
                      <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                        {t("streams.mirror")}
                      </Badge>
                    )}
                    {s.is_source && (
                      <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                        {t("streams.source")}
                      </Badge>
                    )}
                  </span>
                  <span className="truncate text-[var(--fg-muted)]">
                    {s.subjects.length > 0 ? s.subjects.join(", ") : "—"}
                  </span>
                  <span className="text-right tabular-nums">{s.messages}</span>
                  <span data-testid={`stream-rate-${s.name}`} className="text-right tabular-nums">
                    {rateCell(rates?.get(s.name))}
                  </span>
                  <span className="text-right tabular-nums">{formatBytes(s.bytes)}</span>
                  <span className="text-right tabular-nums">{s.consumers}</span>
                  <span className="truncate text-[var(--fg-muted)]">{formatTime(s.last_time_ms)}</span>
                  <span
                    data-testid={`stream-replicas-${s.name}`}
                    className="flex items-center justify-end gap-1 tabular-nums"
                  >
                    {s.replica_count}
                    {unhealthy && (
                      <span
                        data-testid="stream-unhealthy"
                        title={t("streams.unhealthyReplicas", { n: s.unhealthy_replicas })}
                        aria-label={t("streams.unhealthyReplicas", { n: s.unhealthy_replicas })}
                        className="text-[var(--danger-fg)]"
                      >
                        ●{s.unhealthy_replicas}
                      </span>
                    )}
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
