import { useState } from "react";
import { FolderOpen, Pencil, Trash2, Download } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { formatBytes } from "../messages/schema";
import type { ObjectOut } from "../../lib/bindings";
import type { ObjDownloadState } from "./useObjects";
import { joinFilePath, renameNameSchema } from "./schema";
import { Badge } from "@/components/ui/badge";
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

// Column template shared by the header and body rows (one source of truth):
// name / size / chunks / modified / actions.
const GRID_COLS = "grid-cols-[minmax(0,1fr)_76px_60px_150px_150px]";

/** ms epoch → local date-time; 0 → "—" (never a bogus 1970 date). */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

export interface ObjectListProps {
  objects: ObjectOut[];
  loading: boolean;
  /** Per-object download progress/digest state (obj:transfer events). */
  downloads: Map<string, ObjDownloadState>;
  /** 下载: pick a directory then DownloadObject (the native dir pick gates it,
   * no AlertDialog). */
  onDownload: (name: string) => void;
  /** 改名 (L1-lite): the dialog collects the new name, the page calls the
   * binding (toast/refresh included). */
  onRename: (name: string, newName: string) => Promise<unknown>;
  /** 删除 (L1 confirm lives in the page). */
  onDelete: (name: string) => void;
  /** Reveal a finished download in the OS file manager. */
  onOpenDir: (path: string) => void;
  /** True while the selected bucket is sealed (writes are refused). */
  sealed: boolean;
}

/**
 * Object table for the selected bucket (spec §6.9): name / size / chunks /
 * modified / 已删除 badge, with per-row 下载 (progress bar + digest chip +
 * 「打开所在目录」on completion), 改名 and 删除. Download progress and the
 * digest verdict are driven entirely by obj:transfer events keyed by object
 * name; a digest mismatch keeps the file on disk for manual comparison, so
 * the open-directory button shows for both ✓ and ✗.
 */
export function ObjectList({
  objects,
  loading,
  downloads,
  onDownload,
  onRename,
  onDelete,
  onOpenDir,
  sealed,
}: ObjectListProps) {
  const { t } = useTranslation();
  const [rename, setRename] = useState<{ open: boolean; from: string; to: string }>({
    open: false,
    from: "",
    to: "",
  });

  const renameValid =
    rename.to.trim().length > 0 &&
    rename.to.trim() !== rename.from &&
    renameNameSchema.safeParse(rename.to).success;

  const submitRename = async () => {
    if (!renameValid) return;
    await onRename(rename.from, rename.to.trim());
    setRename({ open: false, from: "", to: "" });
  };

  return (
    <section data-testid="objects-object-list" className="flex min-h-0 flex-col rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">{t("objects.list.title")}</h3>
      </div>

      {/* Header (shares GRID_COLS with the body rows) */}
      <div
        role="row"
        className={`grid h-8 shrink-0 items-center border-b border-border px-3 text-xs ${GRID_COLS} text-[var(--fg-muted)]`}
      >
        <div role="columnheader">{t("objects.list.colName")}</div>
        <div role="columnheader" className="text-right">{t("objects.list.colSize")}</div>
        <div role="columnheader" className="text-right">{t("objects.list.colChunks")}</div>
        <div role="columnheader">{t("objects.list.colModified")}</div>
        <div role="columnheader" className="text-right">{t("objects.list.colActions")}</div>
      </div>

      {objects.length === 0 ? (
        <p data-testid="objects-objects-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {loading ? t("objects.list.loading") : t("objects.list.empty")}
        </p>
      ) : (
        <div className="max-h-80 overflow-auto">
          {objects.map((o) => {
            const dl = downloads.get(o.name);
            return (
              <div key={o.name} className="border-b border-[var(--border-soft)] last:border-b-0">
                <div
                  data-testid={`objects-object-row-${o.name}`}
                  className={`grid w-full items-center px-3 py-1.5 text-xs ${GRID_COLS}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono" title={o.name}>
                      {o.name}
                    </span>
                    {o.deleted && (
                      <Badge
                        variant="destructive"
                        data-testid="objects-object-deleted-badge"
                        className="shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        {t("objects.list.deleted")}
                      </Badge>
                    )}
                  </span>
                  <span className="text-right tabular-nums">{formatBytes(o.size)}</span>
                  <span className="text-right tabular-nums">{o.chunks}</span>
                  <span className="truncate text-[var(--fg-muted)]">{formatTime(o.mod_time_ms)}</span>
                  <span className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`objects-obj-download-${o.name}`}
                      aria-label={t("objects.list.download")}
                      title={t("objects.list.download")}
                      disabled={dl?.phase === "running"}
                      className="h-7 px-2"
                      onClick={() => onDownload(o.name)}
                    >
                      <Download size={13} strokeWidth={1.75} aria-hidden="true" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`objects-obj-rename-${o.name}`}
                      aria-label={t("objects.list.rename")}
                      title={t("objects.list.rename")}
                      disabled={sealed}
                      className="h-7 px-2"
                      onClick={() => setRename({ open: true, from: o.name, to: o.name })}
                    >
                      <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`objects-obj-delete-${o.name}`}
                      aria-label={t("objects.list.delete")}
                      title={t("objects.list.delete")}
                      className="h-7 px-2 text-[var(--danger-fg)]"
                      onClick={() => onDelete(o.name)}
                    >
                      <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                    </Button>
                  </span>
                </div>

                {/* Download progress + digest verdict (event-driven) */}
                {dl && (
                  <div
                    data-testid={`objects-dl-${o.name}`}
                    className="flex items-center gap-3 px-3 pb-2 pl-6 text-xs"
                  >
                    {dl.phase === "running" ? (
                      <>
                        <Progress
                          data-testid={`objects-dl-progress-${o.name}`}
                          className="h-1.5 max-w-64 flex-1"
                          value={
                            dl.bytes_total > 0 ? (dl.bytes_done / dl.bytes_total) * 100 : undefined
                          }
                          aria-label={t("objects.download.progress")}
                        />
                        <span className="shrink-0 tabular-nums text-[var(--fg-muted)]">
                          {dl.bytes_total > 0
                            ? t("objects.download.bytes", {
                                done: formatBytes(dl.bytes_done),
                                total: formatBytes(dl.bytes_total),
                              })
                            : t("objects.download.indeterminate")}
                        </span>
                      </>
                    ) : (
                      <>
                        {dl.digest_match !== null && (
                          <Badge
                            variant={dl.digest_match ? "outline" : "destructive"}
                            data-testid={`objects-dl-digest-${o.name}`}
                            className="px-1.5 py-0 text-[10px]"
                          >
                            {dl.digest_match
                              ? t("objects.download.digestOk")
                              : t("objects.download.digestBad")}
                          </Badge>
                        )}
                        {dl.phase === "incomplete" && dl.error && (
                          <span
                            className="min-w-0 flex-1 truncate text-[var(--danger-fg)]"
                            title={dl.error}
                          >
                            {dl.error}
                          </span>
                        )}
                        {dl.digest_match !== null && (
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`objects-dl-open-${o.name}`}
                            className="ml-auto h-7 gap-1 px-2"
                            onClick={() => onOpenDir(joinFilePath(dl.dir, o.name))}
                          >
                            <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
                            {t("objects.download.openDir")}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Rename dialog (L1-lite: non-destructive, the new name is collected
          inline; the page's action toasts + refreshes) */}
      <Dialog
        open={rename.open}
        onOpenChange={(o) => {
          if (!o) setRename({ open: false, from: "", to: "" });
        }}
      >
        <DialogContent data-testid="objects-rename" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("objects.rename.title", { name: rename.from })}</DialogTitle>
          </DialogHeader>
          <Input
            data-testid="objects-rename-input"
            aria-label={t("objects.rename.label")}
            value={rename.to}
            onChange={(e) => setRename((r) => ({ ...r, to: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
            }}
          />
          <p className="text-xs text-[var(--fg-muted)]">{t("objects.rename.hint")}</p>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="objects-rename-cancel"
              onClick={() => setRename({ open: false, from: "", to: "" })}
            >
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="objects-rename-confirm"
              disabled={!renameValid}
              onClick={() => void submitRename()}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default ObjectList;
