import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import {
  BackupStream,
  PickBackupDirectory,
  RestoreBackup,
  type CallResult,
} from "../../lib/bindings";
import { formatBytes } from "../messages/schema";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ---- wire payload (internal/jsadmin/backup.go BackupProgress) ----

export type BackupDirection = "backup" | "restore";
export type BackupPhase = "running" | "complete" | "incomplete";

/** stream:backup payload, snake_case wire fields mapped to camelCase. */
export interface BackupProgress {
  stream: string;
  direction: BackupDirection;
  phase: BackupPhase;
  bytesDone: number;
  bytesTotal: number;
  chunksDone: number;
}

interface BackupProgressWire {
  stream?: unknown;
  direction?: unknown;
  phase?: unknown;
  bytes_done?: unknown;
  bytes_total?: unknown;
  chunks_done?: unknown;
}

/** Whitelist parser (connstate parseEvent style): only known field values are
 * accepted, unknown fields are dropped, malformed payloads → null. */
export function parseBackupProgress(data: unknown): BackupProgress | null {
  const d = (data ?? {}) as BackupProgressWire;
  const stream = typeof d.stream === "string" ? d.stream : "";
  const direction =
    d.direction === "backup" || d.direction === "restore" ? d.direction : null;
  const phase =
    d.phase === "running" || d.phase === "complete" || d.phase === "incomplete"
      ? d.phase
      : null;
  if (stream === "" || direction === null || phase === null) return null;
  return {
    stream,
    direction,
    phase,
    bytesDone: typeof d.bytes_done === "number" ? d.bytes_done : 0,
    bytesTotal: typeof d.bytes_total === "number" ? d.bytes_total : 0,
    chunksDone: typeof d.chunks_done === "number" ? d.chunks_done : 0,
  };
}

/**
 * Subscribes to the Wails `stream:backup` event and returns the latest
 * progress matching the given direction (and stream, unless `stream` is null
 * — restore learns the stream name from the events themselves, so it matches
 * any stream). `direction: null` means inactive (no subscription). The
 * subscription is torn down on unmount and whenever the filters change.
 */
export function useBackupProgress(
  stream: string | null,
  direction: BackupDirection | null,
): BackupProgress | null {
  const [progress, setProgress] = useState<BackupProgress | null>(null);

  useEffect(() => {
    setProgress(null);
    if (!direction) return;
    const off = Events.On("stream:backup", (e: { data?: unknown }) => {
      const p = parseBackupProgress(e?.data);
      if (!p) return;
      if (p.direction !== direction) return;
      if (stream !== null && p.stream !== stream) return;
      setProgress(p);
    });
    return () => {
      off();
    };
  }, [stream, direction]);

  return progress;
}

// ---- the panel ----

export interface BackupPanelProps {
  open: boolean;
  mode: BackupDirection;
  /** Backup mode: the stream being snapshotted. Restore ignores it (the
   * target name comes from the backup.json inside the picked directory). */
  stream: string;
  /** List/detail refresh (the page's useStreams().refresh) run after a
   * completed or not-found operation. */
  refresh: () => void;
  onClose: () => void;
}

type Stage = "options" | "running" | "done" | "incomplete" | "confirm-overwrite";

const BUSY_RE = /another backup or restore is already running/;
const TARGET_EXISTS_RE = /already exists/;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Backup/restore dialog (spec §6.6, task 13): a small stage machine shared by
 * both modes. Backup: include-consumers checkbox → directory picker →
 * BackupStream → stream:backup progress → complete/incomplete phase. Restore:
 * directory picker → RestoreBackup(dir,false); a validation "target exists"
 * answer opens the overwrite-confirm sub-stage (删除并重建 checkbox gating the
 * confirm button) before RestoreBackup(dir,true). Success toasts + refresh;
 * "incomplete" renders a warning with the server原文 and NEVER a success
 * toast (§6.6 异常表); the busy mutex error is a plain toast.
 */
export function BackupPanel({ open, mode, stream, refresh, onClose }: BackupPanelProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("options");
  const [includeConsumers, setIncludeConsumers] = useState(false);
  const [overwriteChecked, setOverwriteChecked] = useState(false);
  const [picking, setPicking] = useState(false);
  const [dir, setDir] = useState("");
  const [serverErr, setServerErr] = useState("");
  // Restore learns the target stream name from the progress events.
  const [progressStream, setProgressStream] = useState("");

  // Synchronous mirror of the latest phase: the event lands before the
  // binding's CallResult resolves, so the result handler must not depend on
  // state that React has not flushed yet.
  const phaseRef = useRef<BackupPhase | null>(null);
  const finishedRef = useRef(false);

  const progress = useBackupProgress(
    open && mode === "backup" ? stream : null,
    open ? mode : null,
  );

  // Fresh stage machine on every open / mode switch.
  useEffect(() => {
    if (!open) return;
    setStage("options");
    setIncludeConsumers(false);
    setOverwriteChecked(false);
    setServerErr("");
    setDir("");
    setProgressStream("");
    phaseRef.current = null;
    finishedRef.current = false;
  }, [open, mode]);

  // Phase transitions are event-driven and fire exactly once per operation:
  // complete → success toast + refresh; incomplete → warning stage (the
  // server原文 fills in when the CallResult lands a moment later).
  useEffect(() => {
    if (!progress) return;
    phaseRef.current = progress.phase;
    setProgressStream(progress.stream);
    if (finishedRef.current) return;
    if (progress.phase === "complete") {
      finishedRef.current = true;
      toast.success(
        mode === "restore"
          ? t("streams.backup.restoreDone", { name: progress.stream })
          : t("streams.backup.backupDone", { name: progress.stream }),
      );
      refresh();
      setStage("done");
    } else if (progress.phase === "incomplete") {
      setStage("incomplete");
    }
  }, [progress, mode, t, refresh]);

  /** Shared CallResult tail. Success is event-driven (the server always emits
   * the terminal phase before returning), so a clean result only makes sure
   * the progress view is up. */
  const handleResult = useCallback(
    (res: CallResult | null, retry: boolean) => {
      const r: CallResult = res ?? { error_code: "", error: "" };
      if (!r.error_code) {
        if (phaseRef.current === null) setStage("running");
        return;
      }
      const text = r.error || r.error_code;
      // Busy mutex (§6.6): plain toast, back to options — no special UI.
      if (BUSY_RE.test(text)) {
        toast.error(t("streams.backup.failed", { error: text }));
        setStage("options");
        return;
      }
      // Restore probe hit an existing target → the overwrite-confirm
      // sub-stage gates the retry with overwrite=true.
      if (!retry && mode === "restore" && r.error_code === "validation" && TARGET_EXISTS_RE.test(text)) {
        setServerErr(text);
        setOverwriteChecked(false);
        setStage("confirm-overwrite");
        return;
      }
      // Any other failure toasts the 原文; with an incomplete phase already
      // announced the warning view shows it, otherwise we fall back to options
      // (e.g. invalid backup directory — no events were emitted).
      toast.error(t("streams.backup.failed", { error: text }));
      setServerErr(text);
      setStage(phaseRef.current === "incomplete" ? "incomplete" : "options");
    },
    [mode, t],
  );

  const chooseDir = useCallback(async () => {
    if (picking) return;
    setPicking(true);
    try {
      const d = await PickBackupDirectory();
      if (d === "") {
        // User cancelled the native chooser — no request, panel closes.
        onClose();
        return;
      }
      setDir(d);
      if (mode === "backup") {
        setStage("running");
        try {
          handleResult(await BackupStream(stream, d, includeConsumers), false);
        } catch (err) {
          handleResult({ error_code: "server", error: errText(err) }, false);
        }
      } else {
        try {
          handleResult(await RestoreBackup(d, false), false);
        } catch (err) {
          handleResult({ error_code: "server", error: errText(err) }, false);
        }
      }
    } finally {
      setPicking(false);
    }
  }, [picking, mode, stream, includeConsumers, onClose, handleResult]);

  const confirmOverwrite = useCallback(async () => {
    if (!overwriteChecked || !dir) return;
    setStage("running");
    try {
      handleResult(await RestoreBackup(dir, true), true);
    } catch (err) {
      handleResult({ error_code: "server", error: errText(err) }, true);
    }
  }, [overwriteChecked, dir, handleResult]);

  if (!open) return null;

  const title =
    mode === "backup"
      ? t("streams.backup.titleBackup", { name: stream })
      : t("streams.backup.titleRestore");

  const runningName = mode === "backup" ? stream : progressStream || "…";

  const progressView = (() => {
    if (progress && progress.bytesTotal > 0) {
      return {
        bar: (
          <Progress
            data-testid="backup-progress"
            value={Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100)}
            aria-label={t("streams.backup.progress")}
          />
        ),
        detail: t("streams.backup.bytes", {
          done: formatBytes(progress.bytesDone),
          total: formatBytes(progress.bytesTotal),
          chunks: progress.chunksDone,
        }),
      };
    }
    return {
      // Indeterminate: no byte totals yet (restore events carry chunks only).
      bar: (
        <div
          data-testid="backup-progress"
          className="h-2 w-full overflow-hidden rounded-full bg-primary/20"
        >
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      ),
      detail:
        progress && progress.chunksDone > 0
          ? t("streams.backup.chunksOnly", { chunks: progress.chunksDone })
          : t("streams.backup.indeterminate"),
    };
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent data-testid="backup-panel" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="backup-title">{title}</DialogTitle>
        </DialogHeader>

        {stage === "options" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--fg-muted)]">
              {mode === "backup"
                ? t("streams.backup.backupHint", { name: stream })
                : t("streams.backup.restoreHint")}
            </p>
            {mode === "backup" && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  data-testid="backup-include-consumers"
                  checked={includeConsumers}
                  onCheckedChange={(v) => setIncludeConsumers(v === true)}
                />
                {t("streams.backup.includeConsumers")}
              </label>
            )}
          </div>
        )}

        {stage === "running" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {mode === "backup"
                ? t("streams.backup.runningBackup", { name: runningName })
                : t("streams.backup.runningRestore", { name: runningName })}
            </p>
            {progressView.bar}
            <p className="text-xs tabular-nums text-[var(--fg-muted)]">{progressView.detail}</p>
          </div>
        )}

        {stage === "done" && (
          <div data-testid="backup-done" className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 size={16} className="text-[var(--accent-strong)]" aria-hidden="true" />
              {mode === "backup"
                ? t("streams.backup.backupDone", { name: progressStream || stream })
                : t("streams.backup.restoreDone", { name: progressStream || "…" })}
            </p>
          </div>
        )}

        {stage === "incomplete" && (
          <div
            data-testid="backup-incomplete"
            className="flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm"
          >
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle size={15} aria-hidden="true" />
              {mode === "backup"
                ? t("streams.backup.incompleteBackup")
                : t("streams.backup.incompleteRestore")}
            </p>
            {serverErr && (
              <p className="break-all text-xs text-[var(--fg-muted)]">
                {t("streams.backup.serverError", { error: serverErr })}
              </p>
            )}
          </div>
        )}

        {stage === "confirm-overwrite" && (
          <div data-testid="backup-overwrite" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle size={15} aria-hidden="true" />
                {t("streams.backup.overwriteTitle")}
              </p>
              <p className="text-[var(--fg-muted)]">{t("streams.backup.overwriteBody")}</p>
              {serverErr && (
                <p className="break-all text-xs text-[var(--fg-muted)]">
                  {t("streams.backup.serverError", { error: serverErr })}
                </p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                data-testid="backup-overwrite-check"
                checked={overwriteChecked}
                onCheckedChange={(v) => setOverwriteChecked(v === true)}
              />
              {t("streams.backup.overwriteCheck")}
            </label>
          </div>
        )}

        <DialogFooter>
          {(stage === "options" || stage === "confirm-overwrite") && (
            <Button
              size="sm"
              variant="outline"
              data-testid="backup-cancel"
              onClick={() =>
                stage === "confirm-overwrite" ? setStage("options") : onClose()
              }
            >
              {stage === "confirm-overwrite"
                ? t("streams.backup.back")
                : t("streams.backup.cancel")}
            </Button>
          )}
          {stage === "options" && (
            <Button size="sm" data-testid="backup-pick-dir" onClick={chooseDir} disabled={picking}>
              {picking && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {t("streams.backup.pickDir")}
            </Button>
          )}
          {stage === "confirm-overwrite" && (
            <Button
              size="sm"
              data-testid="backup-overwrite-confirm"
              onClick={confirmOverwrite}
              disabled={!overwriteChecked}
            >
              {t("streams.backup.overwriteConfirm")}
            </Button>
          )}
          {(stage === "done" || stage === "incomplete") && (
            <Button size="sm" data-testid="backup-close" onClick={onClose}>
              {t("streams.backup.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
