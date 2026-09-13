import { useCallback, useMemo, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { useConfirm } from "../../lib/confirm";
import {
  OpenInFileManager,
  PickUploadFiles,
  type CallResult,
  type ObjBucketSummary,
} from "../../lib/bindings";
import { formatBytes } from "../messages/schema";
import { useObjects } from "./useObjects";
import { ObjectList } from "./ObjectList";
import { UploadPanel } from "./UploadPanel";
import { ObjectWatchPanel } from "./ObjectWatchPanel";
import { BucketForm, type BucketFormMode } from "./BucketForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/** Client-side bucket filter (kv 同款: substring on the bucket name or
 * description, case-insensitive). */
export function matchBuckets(buckets: ObjBucketSummary[], query: string): ObjBucketSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return buckets;
  return buckets.filter(
    (b) =>
      b.name.toLowerCase().includes(q) ||
      (b.description ?? "").toLowerCase().includes(q),
  );
}

const KNOWN_REASONS = ["no_responders", "timeout", "server"] as const;

// Bucket rail column template (name / size / sealed).
const BUCKET_COLS = "grid-cols-[minmax(0,1fr)_72px_64px]";

/**
 * Objects page (spec §6.9): left rail with the object bucket list (search,
 * refresh, Create, upload entry), right pane with the selected bucket's
 * config echo and tiered ops (Edit / Delete via L2 name-match / Seal via L1),
 * the object list below (下载 with directory pick + progress + digest chip +
 * open-directory, 改名, 删除 via L1), the upload queue dialog (sequential
 * UploadObject with per-file progress from obj:transfer events) and the
 * object watch panel. Sealed buckets refuse uploads/edits in the UI (badge +
 * hint, §6.9 异常 3) — delete stays enabled since the server accepts it.
 * When the backend reports the bucket list unavailable
 * (unavailable_reason), a guidance panel replaces the table — never an empty
 * grid.
 */
export function ObjectsPage() {
  const { t } = useTranslation();
  const conn = useConnState();
  const api = useObjects();
  const { confirmL1, confirmNameMatch } = useConfirm();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ open: boolean; mode: BucketFormMode }>({
    open: false,
    mode: "create",
  });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busyOp, setBusyOp] = useState<string | null>(null);

  const connected = conn.state === "connected";
  const unavailable = api.unavailableReason !== "";
  const reasonKey = (KNOWN_REASONS as readonly string[]).includes(api.unavailableReason)
    ? `objects.unavailable.${api.unavailableReason}`
    : "objects.unavailable.generic";

  const filteredBuckets = useMemo(() => matchBuckets(api.buckets, query), [api.buckets, query]);
  const selectedName = api.selected ?? "";
  const selectedSummary = useMemo(
    () => api.buckets.find((b) => b.name === selectedName) ?? null,
    [api.buckets, selectedName],
  );
  const sealed = api.detail.sealed;

  const openForm = useCallback((mode: BucketFormMode) => setForm({ open: true, mode }), []);
  const closeForm = useCallback(() => setForm((f) => ({ ...f, open: false })), []);

  // Runs an op with the immediate busy marker; confirm dialogs resolve before
  // the binding call, cancellation just clears the spinner.
  const runOp = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusyOp(key);
    try {
      await fn();
    } finally {
      setBusyOp(null);
    }
  }, []);

  const handleDeleteBucket = useCallback(
    () =>
      runOp("bucket-delete", async () => {
        if (!selectedName) return;
        // Level-2: always shown, confirm only on a character-exact name.
        // The server accepts deletes on sealed buckets, so this stays enabled
        // when sealed (unlike upload/edit).
        const ok = await confirmNameMatch(selectedName);
        if (ok) await api.actions.deleteBucket(selectedName);
      }),
    [runOp, selectedName, confirmNameMatch, api.actions],
  );

  const handleSeal = useCallback(
    () =>
      runOp("seal", async () => {
        if (!selectedName) return;
        // Level-1: sealing is irreversible from this UI (no unseal here).
        const ok = await confirmL1({
          titleKey: "objects.confirm.sealTitle",
          bodyKey: "objects.confirm.sealBody",
          data: { name: selectedName },
        });
        if (ok) await api.actions.sealBucket(selectedName);
      }),
    [runOp, selectedName, confirmL1, api.actions],
  );

  const handleDeleteObject = useCallback(
    (name: string) =>
      runOp(`object-delete-${name}`, async () => {
        if (!selectedName) return;
        // Level-1: DeleteObject marks the object deleted (chunks reclaimed).
        const ok = await confirmL1({
          titleKey: "objects.confirm.deleteObjectTitle",
          bodyKey: "objects.confirm.deleteObjectBody",
          data: { name },
        });
        if (ok) await api.actions.deleteObject(selectedName, name);
      }),
    [runOp, selectedName, confirmL1, api.actions],
  );

  const handleDownload = useCallback(
    (name: string) => {
      if (!selectedName) return;
      // L1-lite: the native directory pick is the gate — cancel means no
      // request. Progress/digest arrive via obj:transfer events.
      void api.downloadObject(selectedName, name);
    },
    [selectedName, api],
  );

  const handleRename = useCallback(
    async (name: string, newName: string) => {
      if (!selectedName) return;
      // RenameObject preserves Description/Headers/Metadata server-side; the
      // UI just relays the new name.
      await api.actions.renameObject(selectedName, name, newName);
    },
    [selectedName, api.actions],
  );

  const handleOpenDir = useCallback((path: string) => {
    // Windows: explorer /select on the exact file. Non-Windows stubs answer a
    // not-implemented CallResult — toast the原文 rather than failing silently.
    void OpenInFileManager(path).then((res: CallResult) => {
      if (res?.error_code) {
        toast.error(t("objects.error.actionFailed", { error: res.error || res.error_code }));
      }
    });
  }, [t]);

  const handlePickFiles = useCallback(() => {
    // Empty answer = the user cancelled the native chooser — no queue change.
    void PickUploadFiles()
      .then((paths) => api.uploads.add((paths ?? []).filter((p) => typeof p === "string" && p)))
      .catch(() => {});
  }, [api.uploads]);

  const detail = api.detail.form;

  return (
    <div data-testid="objects-page" className="flex min-h-0 flex-1">
      {/* Left rail: search + refresh + create + upload entry + bucket list */}
      <aside className="flex w-[440px] min-w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <Input
            data-testid="objects-search"
            aria-label={t("objects.search")}
            placeholder={t("objects.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8"
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="objects-refresh"
            aria-label={t("objects.refresh")}
            onClick={api.refresh}
            disabled={!connected || api.loading}
            className="h-8 shrink-0 px-2"
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            data-testid="objects-op-upload"
            onClick={() => setUploadOpen(true)}
            disabled={!connected || !api.selected || sealed}
            title={sealed ? t("objects.sealedHint") : undefined}
            className="h-8 shrink-0 gap-1"
          >
            <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("objects.op.upload")}
          </Button>
          <Button
            size="sm"
            data-testid="objects-create"
            onClick={() => openForm("create")}
            className="h-8 shrink-0"
          >
            {t("objects.create")}
          </Button>
        </div>

        {!connected ? (
          <div
            data-testid="objects-not-connected"
            className="mx-3 mb-3 rounded-md border border-border bg-panel p-3 text-sm text-[var(--fg-muted)]"
          >
            {t("objects.notConnected")}
          </div>
        ) : unavailable ? (
          <div
            data-testid="objects-unavailable"
            className="mx-3 mb-3 flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm"
          >
            <p className="font-medium">{t("objects.unavailable.title")}</p>
            <p className="text-[var(--fg-muted)]">{t(reasonKey)}</p>
            <ul className="ml-4 list-disc text-xs text-[var(--fg-muted)]">
              <li>{t("objects.unavailable.checkDomain")}</li>
              <li>{t("objects.unavailable.checkPrefix")}</li>
            </ul>
          </div>
        ) : filteredBuckets.length === 0 ? (
          <p data-testid="objects-list-empty" className="p-4 text-sm text-[var(--fg-muted)]">
            {t("objects.listEmpty")}
          </p>
        ) : (
          <div data-testid="objects-bucket-list" className="min-h-0 flex-1 overflow-auto">
            {/* Header (shares BUCKET_COLS with the rows) */}
            <div
              role="row"
              className={`sticky top-0 grid h-8 items-center border-b border-border bg-background px-3 text-xs ${BUCKET_COLS} text-[var(--fg-muted)]`}
            >
              <div role="columnheader">{t("objects.col.name")}</div>
              <div role="columnheader" className="text-right">{t("objects.col.bytes")}</div>
              <div role="columnheader" className="text-right">{t("objects.col.sealed")}</div>
            </div>
            {filteredBuckets.map((b) => (
              <div
                key={b.name}
                data-testid={`objects-bucket-row-${b.name}`}
                role="button"
                tabIndex={0}
                aria-pressed={api.selected === b.name}
                onClick={() => api.select(b.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") api.select(b.name);
                }}
                className={`grid w-full cursor-pointer items-center px-3 py-1.5 text-xs hover:bg-[var(--accent-soft)] ${BUCKET_COLS} ${
                  api.selected === b.name ? "bg-[var(--accent-soft)]" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium" title={b.name}>
                    {b.name}
                  </span>
                  {b.description && (
                    <span className="truncate text-[var(--fg-faint)]" title={b.description}>
                      {b.description}
                    </span>
                  )}
                </span>
                <span className="text-right tabular-nums">{formatBytes(b.size)}</span>
                <span className="flex justify-end">
                  {b.sealed && (
                    <Badge
                      variant="secondary"
                      data-testid="objects-sealed-badge"
                      className="shrink-0 px-1.5 py-0 text-[10px]"
                    >
                      {t("objects.sealedBadge")}
                    </Badge>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Right pane: bucket detail + object list + watch */}
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {!api.selected || !detail ? (
          <div
            data-testid="objects-detail-empty"
            className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
          >
            <p className="text-sm font-medium">{t("objects.detail.emptyTitle")}</p>
            <p className="max-w-sm text-xs text-[var(--fg-muted)]">{t("objects.detail.emptyBody")}</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            {/* Bucket detail: config echo + ops */}
            <div data-testid="objects-bucket-detail" className="flex flex-col gap-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold" data-testid="objects-bucket-detail-name">
                  {detail.name}
                </h2>
                {detail.description && (
                  <span className="truncate text-xs text-[var(--fg-muted)]">{detail.description}</span>
                )}
                {sealed && (
                  <Badge
                    variant="secondary"
                    data-testid="objects-sealed-detail-badge"
                    className="px-1.5 py-0 text-[10px]"
                  >
                    {t("objects.sealedBadge")}
                  </Badge>
                )}
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {t("objects.detail.replicasBadge", { n: detail.replicas })}
                </Badge>
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="objects-bucket-op-edit"
                    disabled={sealed}
                    title={sealed ? t("objects.sealedHint") : undefined}
                    onClick={() => openForm("edit")}
                  >
                    {t("objects.op.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="objects-bucket-op-seal"
                    disabled={sealed || busyOp === "seal"}
                    onClick={handleSeal}
                  >
                    {t("objects.op.seal")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    data-testid="objects-bucket-op-delete"
                    disabled={busyOp === "bucket-delete"}
                    onClick={handleDeleteBucket}
                  >
                    {t("objects.op.delete")}
                  </Button>
                </div>
              </div>

              {/* Sealed hint (§6.9 异常 3: uploads/edits are refused) */}
              {sealed && (
                <p
                  data-testid="objects-sealed-hint"
                  className="rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-xs text-[var(--fg-muted)]"
                >
                  {t("objects.sealedHint")}
                </p>
              )}

              {/* Config echo grid */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
                <Stat
                  id="size"
                  label={t("objects.detail.size")}
                  value={formatBytes(selectedSummary?.size ?? 0)}
                />
                <Stat id="objects" label={t("objects.detail.objects")} value={String(api.objects.length)} />
                <Stat
                  id="max-bytes"
                  label={t("objects.detail.maxBytes")}
                  value={
                    detail.max_bytes === 0
                      ? t("objects.detail.unset")
                      : detail.max_bytes < 0
                        ? t("objects.detail.unlimited")
                        : formatBytes(detail.max_bytes)
                  }
                />
                <Stat
                  id="ttl"
                  label={t("objects.detail.ttl")}
                  value={(selectedSummary?.ttl_seconds ?? 0) > 0 ? `${selectedSummary?.ttl_seconds}s` : "—"}
                />
                <Stat
                  id="replicas"
                  label={t("objects.detail.replicas")}
                  value={String(detail.replicas || 1)}
                />
              </div>
            </div>

            {/* Object list (download/rename/delete per row) */}
            <ObjectList
              objects={api.objects}
              loading={api.objectsLoading}
              downloads={api.downloads}
              onDownload={handleDownload}
              onRename={handleRename}
              onDelete={handleDeleteObject}
              onOpenDir={handleOpenDir}
              sealed={sealed}
            />

            {/* Watch panel (whole bucket; ≤10k ring) */}
            <ObjectWatchPanel bucket={selectedName} watch={api.watch} />
          </div>
        )}
      </section>

      {/* Bucket create/edit dialog */}
      <BucketForm
        open={form.open}
        mode={form.mode}
        initial={form.mode === "edit" ? detail : null}
        onSubmit={async (values) =>
          form.mode === "edit"
            ? await api.actions.updateBucket(values)
            : await api.actions.createBucket(values)
        }
        onDone={closeForm}
      />

      {/* Upload queue dialog (sequential uploads, event-driven progress) */}
      {uploadOpen && (
        <UploadPanel
          open={uploadOpen}
          bucket={selectedName}
          uploads={api.uploads}
          transfers={api.transfers}
          rates={api.rates}
          onPickFiles={handlePickFiles}
          onClose={() => setUploadOpen(false)}
        />
      )}
    </div>
  );
}

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div
      data-testid={`objects-stat-${id}`}
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-panel px-2.5 py-2"
    >
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
      <span className="truncate text-sm font-medium tabular-nums" title={value}>
        {value}
      </span>
    </div>
  );
}

export default ObjectsPage;
