import { useState } from "react";
import { useTranslation } from "../../app/i18n";
import { formatBytes } from "../messages/schema";
import type { KeyHistoryEntry, KeyMeta, KeyValueOut } from "../../lib/bindings";
import { PayloadView } from "../../lib/payload";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const isDeleteOp = (op: string | undefined): boolean =>
  op === "delete" || op === "purge";

/**
 * Revert availability (spec §6.8 异常 3, mirrors the Go RevertKey rule):
 * disabled when the key has at most one revision (revision ≤ 1) or the
 * latest entry is a delete/purge marker with no earlier valid revision
 * underneath (e.g. after a purge). The backend returns validation+ErrNoHistory
 * as a second line of defense; the UI simply never offers a dead button.
 */
export function canRevert(meta: KeyMeta | null, history: KeyHistoryEntry[]): boolean {
  if (!meta || meta.revision <= 1 || history.length === 0) return false;
  const valid = history.filter((e) => !isDeleteOp(e.operation));
  const latest = history[history.length - 1];
  if (isDeleteOp(latest?.operation)) return valid.length >= 1;
  return valid.length >= 2;
}

export interface KeyDetailProps {
  bucket: string;
  meta: KeyMeta;
  /** Current value from the page's batch fill (or the latest valid history
   * entry as fallback); null = not resolvable. */
  value: KeyValueOut | null;
  history: KeyHistoryEntry[];
  historyLoading: boolean;
  /** Op key ("revert" | "del" | "purge") whose button shows a spinner. */
  busy: string | null;
  onRevert: () => void;
  onDelete: () => void;
  onPurge: () => void;
  onEdit: () => void;
}

/** ms epoch → local date-time; 0 → "—". */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

/**
 * Key detail card (spec §6.8): the current value via the shared PayloadView,
 * the full revision history (revision / time / operation / value view) and
 * the tiered ops — Revert (disabled + tooltip when there is nothing to revert
 * to), Delete (L1: history stays queryable) and Purge (L1: irreversible).
 */
export function KeyDetail({
  bucket,
  meta,
  value,
  history,
  historyLoading,
  busy,
  onRevert,
  onDelete,
  onPurge,
  onEdit,
}: KeyDetailProps) {
  const { t } = useTranslation();
  const [openRev, setOpenRev] = useState<number | null>(null);

  const deleted = isDeleteOp(meta.operation);
  const revertable = canRevert(meta, history);
  const revertTitle = t("kv.keyDetail.revertDisabled");

  return (
    <section data-testid="kv-key-detail" className="flex flex-col gap-3 rounded-md border border-border">
      {/* Header: key + state badges + ops */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="min-w-0 truncate font-mono text-sm font-medium" title={meta.key}>
          {meta.key}
        </h3>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {t("kv.keyDetail.revisionBadge", { revision: meta.revision })}
        </Badge>
        <Badge
          variant={deleted ? "destructive" : "outline"}
          className="px-1.5 py-0 text-[10px]"
        >
          {meta.operation}
        </Badge>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="kv-key-edit"
            onClick={onEdit}
            disabled={busy !== null}
          >
            {t("kv.keyDetail.edit")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="kv-key-revert"
            disabled={!revertable || busy !== null}
            title={revertable ? undefined : revertTitle}
            aria-label={revertable ? t("kv.keyDetail.revert") : revertTitle}
            onClick={onRevert}
          >
            {busy === "revert" && <span className="animate-spin">◌</span>}
            {t("kv.keyDetail.revert")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="kv-key-del"
            disabled={busy !== null}
            onClick={onDelete}
          >
            {t("kv.keyDetail.del")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            data-testid="kv-key-purge"
            disabled={busy !== null}
            onClick={onPurge}
          >
            {t("kv.keyDetail.purge")}
          </Button>
        </div>
      </div>

      {/* Current value (delete markers show a note instead — history stays
          queryable and can be reverted) */}
      <div className="flex flex-col gap-1 px-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)]">{t("kv.keyDetail.value")}</h4>
        {deleted ? (
          <p
            data-testid="kv-key-detail-deleted"
            className="rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-2.5 py-2 text-sm text-[var(--warn)]"
          >
            {t("kv.keyDetail.deleted", { op: meta.operation })}
          </p>
        ) : value && !value.not_found ? (
          <PayloadView
            b64={value.payload_b64}
            isUtf8={value.is_utf8}
            downloadName={`${bucket}-${meta.key.replace(/\//g, "_")}-r${value.revision}.bin`}
            toggle
            testId="kv-key-detail-value"
          />
        ) : (
          <p className="text-sm text-[var(--fg-muted)]">{t("kv.keyDetail.noValue")}</p>
        )}
      </div>

      {/* Revision history */}
      <div className="flex flex-col gap-1 px-3 pb-3">
        <h4 className="text-xs font-medium text-[var(--fg-muted)]">
          {t("kv.keyDetail.history")}
          {historyLoading && (
            <span className="ml-2 font-normal">{t("kv.keys.loading")}</span>
          )}
        </h4>
        {history.length === 0 ? (
          <p className="text-sm text-[var(--fg-muted)]">{t("kv.keyDetail.historyEmpty")}</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <div className="grid grid-cols-[64px_150px_84px_1fr_auto] items-center gap-2 border-b border-border bg-[var(--panel,transparent)] px-2.5 py-1.5 text-xs text-[var(--fg-muted)]">
              <span>{t("kv.keyDetail.colRevision")}</span>
              <span>{t("kv.keyDetail.colTime")}</span>
              <span>{t("kv.keyDetail.colOp")}</span>
              <span>{t("kv.keyDetail.colSize")}</span>
              <span />
            </div>
            {[...history].reverse().map((e) => (
              <div
                key={e.revision}
                data-testid={`kv-history-row-${e.revision}`}
                className="grid grid-cols-[64px_150px_84px_1fr_auto] items-center gap-2 border-b border-[var(--border-soft)] px-2.5 py-1.5 text-xs last:border-b-0"
              >
                <span className="tabular-nums">#{e.revision}</span>
                <span className="truncate text-[var(--fg-muted)]">{formatTime(e.created_ms)}</span>
                <span>
                  <Badge
                    variant={isDeleteOp(e.operation) ? "destructive" : "outline"}
                    className="px-1.5 py-0 text-[10px]"
                  >
                    {e.operation}
                  </Badge>
                </span>
                <span className="tabular-nums text-[var(--fg-muted)]">
                  {isDeleteOp(e.operation) ? "—" : formatBytes(e.payload_size)}
                </span>
                {!isDeleteOp(e.operation) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    data-testid={`kv-history-view-${e.revision}`}
                    aria-expanded={openRev === e.revision}
                    onClick={() => setOpenRev((r) => (r === e.revision ? null : e.revision))}
                  >
                    {openRev === e.revision ? t("kv.keyDetail.hide") : t("kv.keyDetail.view")}
                  </Button>
                )}
              </div>
            ))}
            {openRev !== null && (() => {
              const entry = history.find((e) => e.revision === openRev);
              if (!entry || isDeleteOp(entry.operation)) return null;
              return (
                <div className="border-t border-border px-2.5 py-2">
                  <PayloadView
                    b64={entry.payload_b64}
                    isUtf8={entry.is_utf8}
                    downloadName={`${bucket}-${meta.key.replace(/\//g, "_")}-r${entry.revision}.bin`}
                    testId={`kv-history-payload-${entry.revision}`}
                  />
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </section>
  );
}
