import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { useConfirm } from "../../lib/confirm";
import { formatBytes } from "../../lib/format";
import type { KvBucketSummary, KeyValueOut } from "../../lib/bindings";
import { useKv } from "./useKv";
import { KeyList } from "./KeyList";
import { KeyDetail } from "./KeyDetail";
import { KeyEditor } from "./KeyEditor";
import { WatchPanel } from "./WatchPanel";
import { BucketForm, type BucketFormMode } from "./BucketForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/** Client-side bucket filter (spec §6.8: substring on the bucket name or
 * description, case-insensitive). */
export function matchBuckets(buckets: KvBucketSummary[], query: string): KvBucketSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return buckets;
  return buckets.filter(
    (b) =>
      b.name.toLowerCase().includes(q) ||
      (b.description ?? "").toLowerCase().includes(q),
  );
}

const isDeleteOp = (op: string | undefined): boolean =>
  op === "delete" || op === "purge";

const KNOWN_REASONS = ["no_responders", "timeout", "server"] as const;

// Bucket rail column template (name / keys / bytes / history / ttl).
const BUCKET_COLS = "grid-cols-[minmax(0,1fr)_52px_72px_60px_64px]";

/**
 * KV page (spec §6.8): left rail with the KV bucket list (search, refresh,
 * Create), right pane with the selected bucket's config echo and tiered ops
 * (Edit / Delete via L2 name-match / Compact via L1 with the
 * 「将清除全部删除标记与历史」 wording), the key area below (client-side
 * pagination + value batch fill; row click → key detail with history,
 * revert, delete/purge and the editor entry), and the watch panel. When the
 * backend reports the bucket list unavailable (unavailable_reason), a
 * guidance panel replaces the table — never an empty grid.
 */
export function KeyValuePage() {
  const { t } = useTranslation();
  const conn = useConnState();
  const api = useKv();
  const { confirmL1, confirmNameMatch } = useConfirm();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ open: boolean; mode: BucketFormMode }>({
    open: false,
    mode: "create",
  });
  // Editor: null initial = fresh key (put); non-null = prefill from the
  // existing value (key name frozen).
  const [editor, setEditor] = useState<{ open: boolean; initial: KeyValueOut | null }>({
    open: false,
    initial: null,
  });
  const [busyOp, setBusyOp] = useState<string | null>(null);

  const connected = conn.state === "connected";
  const unavailable = api.unavailableReason !== "";
  const reasonKey = (KNOWN_REASONS as readonly string[]).includes(api.unavailableReason)
    ? `kv.unavailable.${api.unavailableReason}`
    : "kv.unavailable.generic";

  const filteredBuckets = useMemo(() => matchBuckets(api.buckets, query), [api.buckets, query]);
  const selectedName = api.selected ?? "";
  const selectedSummary = useMemo(
    () => api.buckets.find((b) => b.name === selectedName) ?? null,
    [api.buckets, selectedName],
  );

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
        const ok = await confirmNameMatch(selectedName);
        if (ok) await api.actions.deleteBucket(selectedName);
      }),
    [runOp, selectedName, confirmNameMatch, api.actions],
  );

  const handleCompact = useCallback(
    () =>
      runOp("compact", async () => {
        if (!selectedName) return;
        const ok = await confirmL1({
          titleKey: "kv.confirm.compactTitle",
          bodyKey: "kv.confirm.compactBody",
          data: { name: selectedName },
        });
        if (ok) await api.actions.compactBucket(selectedName);
      }),
    [runOp, selectedName, confirmL1, api.actions],
  );

  /** Current value of the selected key: the page batch fill first, falling
   * back to the newest valid history entry (the batch only covers the
   * current page; history always has the values). */
  const selectedKeyValue = useMemo<KeyValueOut | null>(() => {
    if (!api.selectedKey) return null;
    const v = api.pageValues.get(api.selectedKey.key);
    if (v) return v;
    const valid = [...api.history].reverse().find((e) => !isDeleteOp(e.operation));
    if (!valid) return null;
    return {
      key: api.selectedKey.key,
      revision: valid.revision,
      payload_b64: valid.payload_b64,
      payload_size: valid.payload_size,
      is_utf8: valid.is_utf8,
      created_ms: valid.created_ms,
      operation: valid.operation,
      not_found: false,
    };
  }, [api.selectedKey, api.pageValues, api.history]);

  const openEditorForSelectedKey = useCallback(() => {
    if (!api.selectedKey || !selectedName) return;
    const initial: KeyValueOut =
      selectedKeyValue ??
      {
        key: api.selectedKey.key,
        revision: api.selectedKey.revision,
        payload_b64: "",
        payload_size: 0,
        is_utf8: true,
        created_ms: api.selectedKey.created_ms,
        operation: api.selectedKey.operation,
        not_found: false,
      };
    setEditor({ open: true, initial });
  }, [api.selectedKey, selectedName, selectedKeyValue]);

  const handleRevert = useCallback(
    () =>
      runOp("revert", async () => {
        if (!api.selectedKey || !selectedName) return;
        await api.actions.revertKey(selectedName, api.selectedKey.key);
      }),
    [runOp, api.selectedKey, selectedName, api.actions],
  );

  const handleDeleteKey = useCallback(
    () =>
      runOp("del", async () => {
        if (!api.selectedKey || !selectedName) return;
        // L1: a delete marker keeps the history queryable / revertible.
        const ok = await confirmL1({
          titleKey: "kv.confirm.delTitle",
          bodyKey: "kv.confirm.delBody",
          data: { key: api.selectedKey.key },
        });
        if (ok) await api.actions.deleteKey(selectedName, api.selectedKey.key, "delete");
      }),
    [runOp, api.selectedKey, selectedName, confirmL1, api.actions],
  );

  const handlePurgeKey = useCallback(
    () =>
      runOp("purge", async () => {
        if (!api.selectedKey || !selectedName) return;
        // L1: purge removes every revision — irreversible.
        const ok = await confirmL1({
          titleKey: "kv.confirm.purgeTitle",
          bodyKey: "kv.confirm.purgeBody",
          data: { key: api.selectedKey.key },
        });
        if (ok) await api.actions.deleteKey(selectedName, api.selectedKey.key, "purge");
      }),
    [runOp, api.selectedKey, selectedName, confirmL1, api.actions],
  );

  const detail = api.detail;

  return (
    <div data-testid="kv-page" className="flex min-h-0 flex-1">
      {/* Left rail: search + refresh + create + bucket list */}
      <aside className="flex w-[440px] min-w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <Input
            data-testid="kv-search"
            aria-label={t("kv.search")}
            placeholder={t("kv.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8"
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="kv-refresh"
            aria-label={t("kv.refresh")}
            onClick={api.refresh}
            disabled={!connected || api.loading}
            className="h-8 shrink-0 px-2"
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            data-testid="kv-create"
            onClick={() => openForm("create")}
            className="h-8 shrink-0"
          >
            {t("kv.create")}
          </Button>
        </div>

        {!connected ? (
          <div
            data-testid="kv-not-connected"
            className="mx-3 mb-3 rounded-md border border-border bg-panel p-3 text-sm text-[var(--fg-muted)]"
          >
            {t("kv.notConnected")}
          </div>
        ) : unavailable ? (
          <div
            data-testid="kv-unavailable"
            className="mx-3 mb-3 flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm"
          >
            <p className="font-medium">{t("kv.unavailable.title")}</p>
            <p className="text-[var(--fg-muted)]">{t(reasonKey)}</p>
            <ul className="ml-4 list-disc text-xs text-[var(--fg-muted)]">
              <li>{t("kv.unavailable.checkDomain")}</li>
              <li>{t("kv.unavailable.checkPrefix")}</li>
            </ul>
          </div>
        ) : filteredBuckets.length === 0 ? (
          <p data-testid="kv-list-empty" className="p-4 text-sm text-[var(--fg-muted)]">
            {t("kv.listEmpty")}
          </p>
        ) : (
          <div data-testid="kv-bucket-list" className="min-h-0 flex-1 overflow-auto">
            {/* Header (shares BUCKET_COLS with the rows) */}
            <div
              role="row"
              className={`sticky top-0 grid h-8 items-center border-b border-border bg-background px-3 text-xs ${BUCKET_COLS} text-[var(--fg-muted)]`}
            >
              <div role="columnheader">{t("kv.col.name")}</div>
              <div role="columnheader" className="text-right">{t("kv.col.keys")}</div>
              <div role="columnheader" className="text-right">{t("kv.col.bytes")}</div>
              <div role="columnheader" className="text-right">{t("kv.col.history")}</div>
              <div role="columnheader" className="text-right">{t("kv.col.ttl")}</div>
            </div>
            {filteredBuckets.map((b) => (
              <div
                key={b.name}
                data-testid={`kv-bucket-row-${b.name}`}
                role="button"
                tabIndex={0}
                aria-pressed={api.selected === b.name}
                onClick={() => api.select(b.name)}
                onKeyDown={(e) => {
                  // M6 Task 8 ⑲: role="button" rows answer Space as well as
                  // Enter; preventDefault stops the list scroll.
                  if (e.key === "Enter" || e.key === " ") {
                    if (e.key === " ") e.preventDefault();
                    api.select(b.name);
                  }
                }}
                className={`grid w-full cursor-pointer items-center px-3 py-1.5 text-xs hover:bg-[var(--accent-soft)] ${BUCKET_COLS} ${
                  api.selected === b.name ? "bg-[var(--accent-soft)]" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium" title={b.name}>
                    {b.name}
                  </span>
                  {b.is_compressed && (
                    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                      {t("kv.compressed")}
                    </Badge>
                  )}
                </span>
                <span className="text-right tabular-nums">{b.values}</span>
                <span className="text-right tabular-nums">{formatBytes(b.bytes)}</span>
                <span className="text-right tabular-nums">{b.history}</span>
                <span className="text-right tabular-nums">
                  {b.ttl_seconds > 0 ? `${b.ttl_seconds}s` : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Right pane: bucket detail + key area + watch */}
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {!api.selected || !detail ? (
          <div
            data-testid="kv-detail-empty"
            className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
          >
            <p className="text-sm font-medium">{t("kv.detail.emptyTitle")}</p>
            <p className="max-w-sm text-xs text-[var(--fg-muted)]">{t("kv.detail.emptyBody")}</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            {/* Bucket detail: config echo + ops */}
            <div data-testid="kv-bucket-detail" className="flex flex-col gap-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold" data-testid="kv-bucket-detail-name">
                  {detail.name}
                </h2>
                {detail.description && (
                  <span className="truncate text-xs text-[var(--fg-muted)]">{detail.description}</span>
                )}
                {selectedSummary?.is_compressed && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {t("kv.compressed")}
                  </Badge>
                )}
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {t("kv.detail.replicasBadge", { n: detail.replicas })}
                </Badge>
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="kv-bucket-op-edit"
                    onClick={() => openForm("edit")}
                  >
                    {t("kv.op.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="kv-bucket-op-compact"
                    disabled={busyOp === "compact"}
                    onClick={handleCompact}
                  >
                    {t("kv.op.compact")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    data-testid="kv-bucket-op-delete"
                    disabled={busyOp === "bucket-delete"}
                    onClick={handleDeleteBucket}
                  >
                    {t("kv.op.delete")}
                  </Button>
                </div>
              </div>

              {/* Config echo grid */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
                <Stat id="history" label={t("kv.detail.history")} value={String(detail.history || 1)} />
                <Stat
                  id="ttl"
                  label={t("kv.detail.ttl")}
                  value={detail.ttl_seconds > 0 ? `${detail.ttl_seconds}s` : "—"}
                />
                <Stat
                  id="max-bytes"
                  label={t("kv.detail.maxBytes")}
                  value={detail.max_bytes === 0 ? t("kv.detail.unset") : detail.max_bytes < 0 ? t("kv.detail.unlimited") : formatBytes(detail.max_bytes)}
                />
                <Stat
                  id="max-value-size"
                  label={t("kv.detail.maxValueSize")}
                  value={detail.max_value_size === 0 ? t("kv.detail.unset") : detail.max_value_size < 0 ? t("kv.detail.unlimited") : formatBytes(detail.max_value_size)}
                />
                <Stat id="keys" label={t("kv.detail.keys")} value={String(selectedSummary?.values ?? api.keys.length)} />
              </div>
              {detail.description && (
                <p className="text-xs text-[var(--fg-muted)]">{detail.description}</p>
              )}
            </div>

            {/* Key area */}
            <KeyList
              keys={api.pagedKeys}
              pageValues={api.pageValues}
              page={api.page}
              pageCount={Math.max(1, Math.ceil(api.filteredCount / api.pageSize))}
              pageSize={api.pageSize}
              filter={api.filter}
              loading={api.keysLoading}
              truncated={api.keysTruncated}
              selectedKey={api.selectedKey?.key ?? null}
              onFilterChange={api.setFilter}
              onPageChange={api.setPage}
              onPageSizeChange={api.setPageSize}
              onSelect={api.selectKey}
              onPut={() => setEditor({ open: true, initial: null })}
            />

            {/* Key detail (current value + history + tiered ops) */}
            {api.selectedKey && (
              <KeyDetail
                bucket={selectedName}
                meta={api.selectedKey}
                value={selectedKeyValue}
                history={api.history}
                historyLoading={api.historyLoading}
                busy={busyOp}
                onRevert={handleRevert}
                onDelete={handleDeleteKey}
                onPurge={handlePurgeKey}
                onEdit={openEditorForSelectedKey}
              />
            )}

            {/* Watch panel (whole bucket or key filter; ≤10k ring) */}
            <WatchPanel bucket={selectedName} watch={api.watch} />
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

      {/* Key editor dialog (put / create / update + conflict handling) */}
      <KeyEditor
        open={editor.open}
        bucket={selectedName}
        initial={editor.initial}
        onSubmit={api.actions.putKey}
        onDone={() => setEditor((e) => ({ ...e, open: false }))}
      />
    </div>
  );
}

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div
      data-testid={`kv-stat-${id}`}
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-panel px-2.5 py-2"
    >
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
      <span className="truncate text-sm font-medium tabular-nums" title={value}>
        {value}
      </span>
    </div>
  );
}

export default KeyValuePage;
