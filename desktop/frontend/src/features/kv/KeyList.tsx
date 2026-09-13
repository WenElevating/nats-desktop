import { useTranslation } from "../../app/i18n";
import { formatBytes } from "../messages/schema";
import type { KeyMeta, KeyValueOut } from "../../lib/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const KEY_PAGE_SIZES = [20, 50, 100] as const;

// Column template shared by the header and body rows (one source of truth).
const GRID_COLS = "grid-cols-[minmax(0,1fr)_72px_84px_150px_72px]";

/** ms epoch → local date-time; 0 → "—" (never a bogus 1970 date). */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

export interface KeyListProps {
  /** Current page slice of the filtered keys. */
  keys: KeyMeta[];
  /** Batch-fetched values for the current page, keyed by key name. */
  pageValues: Map<string, KeyValueOut>;
  page: number;
  pageCount: number;
  pageSize: number;
  filter: string;
  loading: boolean;
  selectedKey: string | null;
  onFilterChange: (s: string) => void;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
  onSelect: (k: KeyMeta) => void;
  /** Toolbar entry: open the editor for a fresh key (put is unconditional). */
  onPut: () => void;
}

/**
 * Key table for the selected bucket (spec §6.8): client-side name filter +
 * pagination (20/50/100), the metadata columns (key / current revision /
 * operation badge / last modified) and the value-size column filled from the
 * current page's GetKeyValues batch. Delete/purge markers keep their rows
 * (「历史可查」浏览语义) and show the destructive op badge.
 */
export function KeyList({
  keys,
  pageValues,
  page,
  pageCount,
  pageSize,
  filter,
  loading,
  selectedKey,
  onFilterChange,
  onPageChange,
  onPageSizeChange,
  onSelect,
  onPut,
}: KeyListProps) {
  const { t } = useTranslation();

  const opBadge = (op: string) => {
    const destructive = op === "delete" || op === "purge";
    return (
      <Badge
        variant={destructive ? "destructive" : "outline"}
        data-testid={`kv-key-op-${op}`}
        className="px-1.5 py-0 text-[10px]"
      >
        {op}
      </Badge>
    );
  };

  return (
    <section data-testid="kv-key-list" className="flex min-h-0 flex-col rounded-md border border-border">
      {/* Toolbar: name filter + page size + put entry */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">{t("kv.keys.title")}</h3>
        <Input
          data-testid="kv-key-filter"
          aria-label={t("kv.keys.filter")}
          placeholder={t("kv.keys.filter")}
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          className="h-8 ml-2 max-w-56"
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="kv-keys-put"
          className="ml-auto h-8 shrink-0"
          onClick={onPut}
        >
          {t("kv.keys.put")}
        </Button>
      </div>

      {/* Header (shares GRID_COLS with the body rows) */}
      <div
        role="row"
        className={`grid h-8 shrink-0 items-center border-b border-border px-3 text-xs ${GRID_COLS} text-[var(--fg-muted)]`}
      >
        <div role="columnheader">{t("kv.keys.colKey")}</div>
        <div role="columnheader" className="text-right">{t("kv.keys.colRevision")}</div>
        <div role="columnheader">{t("kv.keys.colOp")}</div>
        <div role="columnheader">{t("kv.keys.colModified")}</div>
        <div role="columnheader" className="text-right">{t("kv.keys.colSize")}</div>
      </div>

      {keys.length === 0 ? (
        <p data-testid="kv-keys-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {loading ? t("kv.keys.loading") : t("kv.keys.empty")}
        </p>
      ) : (
        <div className="max-h-72 overflow-auto">
          {keys.map((k) => {
            const v = pageValues.get(k.key);
            return (
              <div
                key={k.key}
                data-testid={`kv-key-row-${k.key}`}
                role="button"
                tabIndex={0}
                aria-pressed={selectedKey === k.key}
                onClick={() => onSelect(k)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect(k);
                }}
                className={`grid w-full cursor-pointer items-center px-3 py-1.5 text-xs hover:bg-[var(--accent-soft)] ${GRID_COLS} ${
                  selectedKey === k.key ? "bg-[var(--accent-soft)]" : ""
                }`}
              >
                <span className="truncate font-mono" title={k.key}>
                  {k.key}
                </span>
                <span className="text-right tabular-nums">{k.revision}</span>
                <span>{opBadge(k.operation)}</span>
                <span className="truncate text-[var(--fg-muted)]">{formatTime(k.created_ms)}</span>
                <span className="text-right tabular-nums">
                  {v && !v.not_found ? formatBytes(v.payload_size) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination footer */}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
        <span data-testid="kv-keys-page" className="text-[var(--fg-muted)]">
          {t("kv.keys.pageInfo", { page: page + 1, total: pageCount })}
        </span>
        <Button
          size="sm"
          variant="outline"
          data-testid="kv-keys-prev"
          className="h-7 px-2"
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
        >
          {t("kv.keys.prev")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="kv-keys-next"
          className="h-7 px-2"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
        >
          {t("kv.keys.next")}
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-[var(--fg-muted)]">
          {t("kv.keys.pageSize")}
          <select
            data-testid="kv-keys-size"
            aria-label={t("kv.keys.pageSize")}
            className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {KEY_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
