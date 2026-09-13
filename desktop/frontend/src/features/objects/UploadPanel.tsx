import { CheckCircle2, Loader2, Plus, Trash2, AlertTriangle } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { formatBytes } from "../messages/schema";
import type { ObjTransferEvent } from "./useObjects";
import type { ObjUploadApi } from "./useObjects";
import { basename } from "./schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface UploadPanelProps {
  open: boolean;
  bucket: string;
  uploads: ObjUploadApi;
  /** All transfer events seen this session (keyed by transfer_id). */
  transfers: Map<string, ObjTransferEvent>;
  /** Frontend-diffed transfer rates (bytes/s, keyed by transfer_id). */
  rates: Map<string, number>;
  onPickFiles: () => void;
  onClose: () => void;
}

/**
 * Upload queue dialog (spec §6.9): 选择文件 (native multi-select → queue) →
 * optional per-file rename → 开始 drains the queue sequentially (the backend
 * is single-flight; the queue IS the concurrency gate). Progress per file is
 * driven by obj:transfer events linked to the item's transfer_id (rate is the
 * frontend's own byte diff), phase=incomplete marks the row red with a 重试
 * button that re-calls UploadObject with the same args (Global 2). All-
 * complete is reflected in the object list (the hook refreshes per item).
 * The queue lives in useObjects, so closing the dialog never cancels a
 * running upload — reopening shows the live progress again.
 */
export function UploadPanel({
  open,
  bucket,
  uploads,
  transfers,
  rates,
  onPickFiles,
  onClose,
}: UploadPanelProps) {
  const { t } = useTranslation();

  const pendingCount = uploads.items.filter((it) => it.status === "pending").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent data-testid="objects-upload" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle data-testid="objects-upload-title">
            {t("objects.upload.title", { bucket })}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="objects-upload-pick"
              disabled={uploads.running}
              onClick={onPickFiles}
            >
              <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
              {t("objects.upload.pick")}
            </Button>
            <p className="text-xs text-[var(--fg-muted)]">{t("objects.upload.hint")}</p>
          </div>

          {uploads.items.length === 0 ? (
            <p data-testid="objects-upload-empty" className="p-3 text-sm text-[var(--fg-muted)]">
              {t("objects.upload.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {uploads.items.map((item, i) => {
                const ev = item.transferId ? transfers.get(item.transferId) : undefined;
                const rate = item.transferId ? (rates.get(item.transferId) ?? 0) : 0;
                const pct =
                  ev && ev.bytes_total > 0
                    ? Math.min(100, Math.round((ev.bytes_done / ev.bytes_total) * 100))
                    : null;
                return (
                  <div
                    key={item.id}
                    data-testid={`objects-upload-item-${i}`}
                    className={`flex flex-col gap-1 rounded-md border border-border px-2.5 py-2 ${
                      item.status === "incomplete" ? "border-[var(--danger-fg)]" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono" title={item.path}>
                        {basename(item.path)}
                      </span>
                      <Input
                        data-testid={`objects-upload-rename-${i}`}
                        aria-label={t("objects.upload.renameLabel", { name: basename(item.path) })}
                        placeholder={t("objects.upload.renameHint")}
                        value={item.rename}
                        disabled={item.status === "uploading"}
                        className="h-7 max-w-44 font-mono text-xs"
                        onChange={(e) => uploads.setRename(item.id, e.target.value)}
                      />
                      {item.status === "pending" && !uploads.running && (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`objects-upload-remove-${i}`}
                          aria-label={t("objects.upload.remove")}
                          className="h-7 px-1.5 text-[var(--fg-muted)]"
                          onClick={() => uploads.remove(item.id)}
                        >
                          <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                        </Button>
                      )}
                      <span
                        data-testid={`objects-upload-status-${i}`}
                        className={`flex w-40 shrink-0 items-center justify-end gap-1 text-right text-[11px] ${
                          item.status === "incomplete" ? "text-[var(--danger-fg)]" : ""
                        }`}
                      >
                        {item.status === "uploading" && (
                          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                        )}
                        {item.status === "complete" && (
                          <CheckCircle2
                            size={12}
                            className="text-[var(--accent-strong)]"
                            aria-hidden="true"
                          />
                        )}
                        {item.status === "incomplete" && (
                          <AlertTriangle size={12} aria-hidden="true" />
                        )}
                        {t(`objects.upload.status.${item.status}`)}
                      </span>
                    </div>

                    {/* Progress (event-driven) / rate / error + retry */}
                    {ev && (
                      <div className="flex items-center gap-2 pl-1">
                        <Progress
                          data-testid={`objects-upload-progress-${i}`}
                          className="h-1.5 max-w-64 flex-1"
                          value={pct ?? undefined}
                          aria-label={t("objects.upload.progressAria")}
                        />
                        <span className="shrink-0 tabular-nums text-[11px] text-[var(--fg-muted)]">
                          {pct !== null ? `${pct}%` : t("objects.upload.indeterminate")}
                          {rate > 0 && item.status === "uploading"
                            ? ` · ${formatBytes(rate)}/s`
                            : ""}
                        </span>
                      </div>
                    )}
                    {item.status === "incomplete" && (
                      <div className="flex items-center gap-2 pl-1">
                        <span
                          className="min-w-0 flex-1 truncate text-[11px] text-[var(--danger-fg)]"
                          title={item.error}
                        >
                          {t("objects.upload.incompleteError", { error: item.error })}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`objects-upload-retry-${i}`}
                          className="h-6 px-2 text-[11px]"
                          onClick={() => uploads.retry(item.id, bucket)}
                        >
                          {t("objects.upload.retry")}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            data-testid="objects-upload-close"
            onClick={onClose}
          >
            {t("common.close")}
          </Button>
          <Button
            data-testid="objects-upload-start"
            disabled={uploads.running || pendingCount === 0 || !bucket}
            onClick={() => uploads.start(bucket)}
          >
            {uploads.running && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {t(uploads.running ? "objects.upload.running" : "objects.upload.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default UploadPanel;
