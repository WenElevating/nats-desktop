import { useCallback, useEffect, useMemo, useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { useConfirm } from "../../lib/confirm";
import type { ConsumerSummary } from "../../lib/bindings";
import { formatRemaining } from "./schema";
import { useConsumers } from "./useConsumers";
import { ConsumerForm, type ConsumerFormMode } from "./ConsumerForm";
import { NextPreview } from "./NextPreview";
import { Sparkline } from "../streams/Sparkline";
import { formatRate } from "../streams/rates";
import { formatBytes } from "../messages/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Client-side filter (spec §6.7 列表筛选): substring match on the consumer
 * name, case-insensitive. */
export function matchConsumers(consumers: ConsumerSummary[], query: string): ConsumerSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return consumers;
  return consumers.filter((c) => c.name.toLowerCase().includes(q));
}

/**
 * Column template shared by the header row and the body rows (one source of
 * truth, exported for a layout regression test — streams-page pattern). The
 * name column takes the remaining fraction; the fixed tracks sum to 400px —
 * inside the 440px rail's content box.
 */
export const CONSUMER_GRID_COLS =
  "grid-cols-[minmax(0,1fr)_44px_52px_52px_60px_52px_48px_48px_44px]";

const KNOWN_REASONS = ["no_responders", "timeout", "server"] as const;

// Sparkline windows (spec §6.7: 5m/15m/1h switch) — 24 points per chart.
const WINDOWS = [
  { key: "5m", ms: 300_000 },
  { key: "15m", ms: 900_000 },
  { key: "1h", ms: 3_600_000 },
] as const;

const SERIES_BUCKETS = 24;

/** ms epoch → local date-time; 0 → "—" (never a bogus 1970 date). */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

/**
 * Consumers page (spec §6.7): left rail with the stream selector (from
 * ListStreams), the name filter, refresh/create and the consumer table; right
 * detail pane with the stats grid, config echo, the delivery-rate sparkline
 * (Δ Delivered.Consumer, natscli consumer graph 同口径, 5m/15m/1h windows),
 * the pause card and the operation buttons. When ListConsumers reports
 * unavailable_reason a guidance panel replaces the table — never an empty
 * list. Tiered danger ops: reset and delete both go through confirmL1
 * (brief: delete 走 L1). The pull preview panel replaces the detail view and
 * is hard-disabled while the consumer is paused (AC-012).
 */
export function ConsumersPage() {
  const { t } = useTranslation();
  const conn = useConnState();
  const [stream, setStream] = useState<string | null>(null);
  const api = useConsumers(stream);
  const { confirmL1 } = useConfirm();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ open: boolean; mode: ConsumerFormMode }>({
    open: false,
    mode: "create",
  });
  const [busyOp, setBusyOp] = useState<string | null>(null);
  // Reset target sequence (0 = clear delivery state, redeliver from the head).
  const [resetSeq, setResetSeq] = useState("0");
  // Pause duration in seconds for the next pause op.
  const [pauseSeconds, setPauseSeconds] = useState("3600");
  // Task 12: the detail pane's preview op swaps in the NextPreview panel (the
  // panel replaces the detail view; close returns to it).
  const [previewOpen, setPreviewOpen] = useState(false);

  // Auto-pick the first stream once the selector data lands.
  useEffect(() => {
    if (!stream && api.streams.length > 0) setStream(api.streams[0].name);
  }, [api.streams, stream]);

  const openForm = useCallback((mode: ConsumerFormMode) => setForm({ open: true, mode }), []);
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

  const selectedName = api.detail?.summary.name ?? api.selected ?? "";
  const paused = api.detail?.summary.paused ?? false;

  const handleReset = useCallback(
    () =>
      runOp("reset", async () => {
        if (!stream || !selectedName) return;
        const seq = Number(resetSeq.trim()) || 0;
        const ok = await confirmL1({
          titleKey: "consumers.confirm.resetTitle",
          bodyKey: "consumers.confirm.resetBody",
          data: { name: selectedName, seq: String(seq) },
        });
        if (ok) await api.reset(stream, selectedName, seq);
      }),
    [runOp, stream, selectedName, resetSeq, confirmL1, api],
  );

  const handleDelete = useCallback(
    () =>
      runOp("delete", async () => {
        if (!stream || !selectedName) return;
        const ok = await confirmL1({
          titleKey: "consumers.confirm.deleteTitle",
          bodyKey: "consumers.confirm.deleteBody",
          data: { name: selectedName, stream: stream },
        });
        if (ok) await api.remove(stream, selectedName);
      }),
    [runOp, stream, selectedName, confirmL1, api],
  );

  const handlePause = useCallback(
    () =>
      runOp("pause", async () => {
        if (!stream || !selectedName) return;
        await api.pause(stream, selectedName, Number(pauseSeconds.trim()) || 0);
      }),
    [runOp, stream, selectedName, pauseSeconds, api],
  );

  const handleResume = useCallback(
    () =>
      runOp("resume", async () => {
        if (!stream || !selectedName) return;
        await api.resume(stream, selectedName);
      }),
    [runOp, stream, selectedName, api],
  );

  const filtered = useMemo(() => matchConsumers(api.consumers, query), [api.consumers, query]);
  const connected = conn.state === "connected";
  const unavailable = api.unavailableReason !== "";
  const reasonKey = (KNOWN_REASONS as readonly string[]).includes(api.unavailableReason)
    ? `consumers.unavailable.${api.unavailableReason}`
    : "consumers.unavailable.generic";

  return (
    <div data-testid="consumers-page" className="flex min-h-0 flex-1">
      {/* Left rail: stream selector + search + refresh/create + list */}
      <aside className="flex w-[440px] min-w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <select
            data-testid="consumers-stream-select"
            aria-label={t("consumers.streamLabel")}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
            value={stream ?? ""}
            disabled={!connected}
            onChange={(e) => setStream(e.target.value || null)}
          >
            {!stream && <option value="">—</option>}
            {api.streams.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            data-testid="consumers-refresh"
            aria-label={t("consumers.refresh")}
            onClick={api.refresh}
            disabled={!connected || api.loading}
            className="h-8 shrink-0 px-2"
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            data-testid="consumers-create"
            onClick={() => openForm("create")}
            disabled={!connected || !stream}
            className="h-8 shrink-0"
          >
            {t("consumers.create")}
          </Button>
        </div>
        <div className="px-3 pb-2">
          <Input
            data-testid="consumers-search"
            aria-label={t("consumers.search")}
            placeholder={t("consumers.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8"
          />
        </div>

        {!connected ? (
          <div
            data-testid="consumers-not-connected"
            className="mx-3 mb-3 rounded-md border border-border bg-panel p-3 text-sm text-[var(--fg-muted)]"
          >
            {t("consumers.notConnected")}
          </div>
        ) : unavailable ? (
          <div
            data-testid="consumers-unavailable"
            className="mx-3 mb-3 flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm"
          >
            <p className="font-medium">{t("consumers.unavailable.title")}</p>
            <p className="text-[var(--fg-muted)]">{t(reasonKey)}</p>
            <ul className="ml-4 list-disc text-xs text-[var(--fg-muted)]">
              <li>{t("consumers.unavailable.checkDomain")}</li>
              <li>{t("consumers.unavailable.checkPrefix")}</li>
            </ul>
          </div>
        ) : (
          <ConsumerList consumers={filtered} selected={api.selected} onSelect={api.select} />
        )}
      </aside>

      {/* Right pane: pull preview panel, detail, or empty-state guidance */}
      <section className="flex min-w-0 flex-1 flex-col">
        {api.detail ? (
          previewOpen ? (
            <NextPreview
              stream={stream ?? ""}
              name={selectedName}
              paused={paused}
              onDone={() => setPreviewOpen(false)}
            />
          ) : (
            <ConsumerDetailPane
              detail={api.detail}
              loading={api.detailLoading}
              rate={api.rate}
              series={api.series}
              busy={busyOp}
              resetSeq={resetSeq}
              onResetSeq={setResetSeq}
              pauseSeconds={pauseSeconds}
              onPauseSeconds={setPauseSeconds}
              onPreview={() => setPreviewOpen(true)}
              onEdit={() => openForm("edit")}
              onCopy={() => openForm("copy")}
              onReset={handleReset}
              onDelete={handleDelete}
              onPause={handlePause}
              onResume={handleResume}
            />
          )
        ) : (
          <div
            data-testid="consumers-detail-empty"
            className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
          >
            <p className="text-sm font-medium">{t("consumers.detail.emptyTitle")}</p>
            <p className="max-w-sm text-xs text-[var(--fg-muted)]">
              {t("consumers.detail.emptyBody")}
            </p>
          </div>
        )}
      </section>

      {/* Create / edit / copy dialog. Copy submits through CreateConsumer so
       * the operator's tweaks travel with the new consumer (streams-page
       * precedent); edit submits through UpdateConsumer. */}
      <ConsumerForm
        open={form.open}
        mode={form.mode}
        stream={stream ?? ""}
        initial={form.mode === "create" ? null : api.detail?.form ?? null}
        onSubmit={async (values) =>
          form.mode === "edit" ? await api.update(values) : await api.create(values)
        }
        onDone={closeForm}
      />
    </div>
  );
}

// ---- left-rail table ----

function ConsumerList({
  consumers,
  selected,
  onSelect,
}: {
  consumers: ConsumerSummary[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const { t } = useTranslation();
  const cols = [
    { key: "name", label: t("consumers.col.name") },
    { key: "type", label: t("consumers.col.type") },
    { key: "pending", label: t("consumers.col.pending"), right: true },
    { key: "ackPending", label: t("consumers.col.ackPending"), right: true },
    { key: "ackFloor", label: t("consumers.col.ackFloor"), right: true },
    { key: "redelivered", label: t("consumers.col.redelivered"), right: true },
    { key: "waiting", label: t("consumers.col.waiting"), right: true },
    { key: "paused", label: t("consumers.col.paused") },
    { key: "replicas", label: t("consumers.col.replicas"), right: true },
  ];
  return (
    <div data-testid="consumers-table" role="table" className="flex min-h-0 flex-1 flex-col">
      <div
        role="row"
        data-testid="consumers-table-header"
        className={`grid h-8 shrink-0 items-center border-b border-border text-xs ${CONSUMER_GRID_COLS} px-3`}
      >
        {cols.map((c) => (
          <div
            key={c.key}
            role="columnheader"
            className={`min-w-0 overflow-hidden whitespace-nowrap ${c.right ? "text-right" : ""}`}
          >
            {c.label}
          </div>
        ))}
      </div>
      {consumers.length === 0 ? (
        <p data-testid="consumers-list-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("consumers.listEmpty")}
        </p>
      ) : (
        <div data-testid="consumers-list" className="min-h-0 flex-1 overflow-auto">
          {consumers.map((c) => (
            <div
              key={c.name}
              data-testid={`consumer-row-${c.name}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected === c.name}
              onClick={() => onSelect(c.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelect(c.name);
              }}
              className={`grid ${CONSUMER_GRID_COLS} w-full cursor-pointer items-center px-3 py-1.5 text-xs hover:bg-[var(--accent-soft)] ${
                selected === c.name ? "bg-[var(--accent-soft)]" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{c.name}</span>
                {c.is_ephemeral && (
                  <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                    {t("consumers.ephemeral")}
                  </Badge>
                )}
              </span>
              <span className="truncate text-[var(--fg-muted)]">
                {c.is_pull ? t("consumers.pull") : t("consumers.push")}
              </span>
              <span className="text-right tabular-nums">{c.num_pending}</span>
              <span className="text-right tabular-nums">{c.num_ack_pending}</span>
              <span className="text-right tabular-nums">{c.ack_floor_consumer}</span>
              <span className="text-right tabular-nums">{c.num_redelivered}</span>
              <span className="text-right tabular-nums">{c.num_waiting}</span>
              <span className="flex justify-center">
                {c.paused && (
                  <Badge
                    variant="outline"
                    data-testid={`consumer-paused-${c.name}`}
                    className="px-1.5 py-0 text-[10px]"
                  >
                    {t("consumers.col.paused")}
                  </Badge>
                )}
              </span>
              <span
                data-testid={`consumer-replicas-${c.name}`}
                className="flex items-center justify-end gap-1 tabular-nums"
              >
                {c.replica_count}
                {c.unhealthy_replicas > 0 && (
                  <span
                    data-testid="consumer-unhealthy"
                    title={t("consumers.unhealthyReplicas", { n: c.unhealthy_replicas })}
                    className="text-[var(--danger-fg)]"
                  >
                    ●{c.unhealthy_replicas}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- detail pane ----

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div
      data-testid={`consumer-stat-${id}`}
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-panel px-2.5 py-2"
    >
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
      <span className="truncate text-sm font-medium tabular-nums" title={value}>
        {value}
      </span>
    </div>
  );
}

function ConfigRow({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div data-testid={`consumer-config-${id}`} className="flex gap-2 text-xs">
      <span className="w-48 shrink-0 text-[var(--fg-muted)]">{label}</span>
      <span className="min-w-0 break-all font-mono">{value}</span>
    </div>
  );
}

interface DetailPaneProps {
  detail: NonNullable<ReturnType<typeof useConsumers>["detail"]>;
  loading: boolean;
  rate: number;
  series: (windowMs: number, buckets: number) => number[];
  busy: string | null;
  resetSeq: string;
  onResetSeq: (v: string) => void;
  pauseSeconds: string;
  onPauseSeconds: (v: string) => void;
  onPreview: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onReset: () => void;
  onDelete: () => void;
  onPause: () => void;
  onResume: () => void;
}

function ConsumerDetailPane(props: DetailPaneProps) {
  const { t } = useTranslation();
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[0].ms);

  const values = useMemo(
    () => props.series(windowMs, SERIES_BUCKETS),
    // `rate` is a deliberate dependency: a new sample must re-draw the chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.series, windowMs, props.rate],
  );

  const s = props.detail.summary;
  const f = props.detail.form;
  const ops = [
    { key: "preview", fn: props.onPreview, disabled: s.paused },
    { key: "edit", fn: props.onEdit, disabled: false },
    { key: "copy", fn: props.onCopy, disabled: false },
    { key: "reset", fn: props.onReset, disabled: false },
    { key: "delete", fn: props.onDelete, disabled: false },
  ] as const;

  return (
    <div
      data-testid="consumer-detail"
      aria-busy={props.loading}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
    >
      {/* Header: name + badges + operation slots */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold" data-testid="consumer-detail-name">
          {s.name}
        </h2>
        <Badge variant="outline">{s.is_pull ? t("consumers.pull") : t("consumers.push")}</Badge>
        {s.is_ephemeral && <Badge variant="secondary">{t("consumers.ephemeral")}</Badge>}
        {s.paused && <Badge variant="secondary">{t("consumers.col.paused")}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {ops.map(({ key, fn, disabled }) => (
            <Button
              key={key}
              size="sm"
              variant="outline"
              data-testid={`consumer-op-${key}`}
              disabled={disabled || props.busy === key}
              onClick={fn}
            >
              {props.busy === key && (
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              )}
              {t(`consumers.op.${key}`)}
            </Button>
          ))}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
        <Stat id="pending" label={t("consumers.detail.pending")} value={String(s.num_pending)} />
        <Stat
          id="ackPending"
          label={t("consumers.detail.ackPending")}
          value={String(s.num_ack_pending)}
        />
        <Stat
          id="ackFloor"
          label={t("consumers.detail.ackFloor")}
          value={String(s.ack_floor_consumer)}
        />
        <Stat
          id="redelivered"
          label={t("consumers.detail.redelivered")}
          value={String(s.num_redelivered)}
        />
        <Stat id="waiting" label={t("consumers.detail.waiting")} value={String(s.num_waiting)} />
        <Stat
          id="delivered"
          label={t("consumers.detail.delivered")}
          value={String(s.delivered_consumer_seq)}
        />
        <Stat id="created" label={t("consumers.detail.created")} value={formatTime(s.created_ms)} />
      </div>

      {/* Rate sparkline + window switch */}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-panel p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--fg-muted)]">
            {t("consumers.detail.rate")}
          </span>
          <span data-testid="consumer-rate" className="text-sm font-medium tabular-nums">
            {props.rate > 0 || props.rate < 0
              ? t("consumers.rate", { rate: formatRate(props.rate) })
              : t("consumers.noData")}
          </span>
          <div
            className="ml-auto flex items-center gap-1"
            role="group"
            aria-label={t("consumers.detail.window")}
          >
            {WINDOWS.map((w) => (
              <Button
                key={w.key}
                size="sm"
                variant={windowMs === w.ms ? "default" : "outline"}
                aria-pressed={windowMs === w.ms}
                data-testid={`consumer-window-${w.key}`}
                onClick={() => setWindowMs(w.ms)}
                className="h-6 px-2 text-xs"
              >
                {t(`consumers.detail.window${w.key}`)}
              </Button>
            ))}
          </div>
        </div>
        <Sparkline
          values={values}
          width={320}
          height={48}
          ariaLabel={
            !Number.isNaN(props.rate) && props.rate !== 0
              ? t("consumers.detail.rateTitle", { rate: formatRate(props.rate) })
              : t("consumers.detail.noRateData")
          }
        />
      </div>

      {/* Pause card (AC-012): paused → formatted remaining + Resume, and the
          pull preview is disabled above; unpaused → duration + Pause. */}
      <div
        data-testid="consumer-pause-card"
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-panel p-3"
      >
        {s.paused ? (
          <>
            <Pause size={14} strokeWidth={1.75} aria-hidden="true" />
            <span data-testid="consumer-pause-remaining" className="text-sm font-medium">
              {t("consumers.detail.pausedRemaining", {
                remaining: formatRemaining(s.pause_remaining_ms),
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              data-testid="consumer-op-resume"
              className="ml-auto"
              disabled={props.busy === "resume"}
              onClick={props.onResume}
            >
              {props.busy === "resume" && (
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              )}
              <Play size={13} strokeWidth={1.75} aria-hidden="true" />
              {t("consumers.op.resume")}
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs font-medium text-[var(--fg-muted)]">
              {t("consumers.pause.seconds")}
            </span>
            <Input
              data-testid="consumer-pause-seconds"
              aria-label={t("consumers.pause.seconds")}
              inputMode="numeric"
              className="h-8 w-24"
              value={props.pauseSeconds}
              onChange={(e) => props.onPauseSeconds(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              data-testid="consumer-op-pause"
              disabled={props.busy === "pause"}
              onClick={props.onPause}
            >
              {props.busy === "pause" && (
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              )}
              <Pause size={13} strokeWidth={1.75} aria-hidden="true" />
              {t("consumers.op.pause")}
            </Button>
          </>
        )}
      </div>

      {/* Reset control: target sequence for the L1-confirmed reset op. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-panel p-3">
        <span className="text-xs font-medium text-[var(--fg-muted)]">
          {t("consumers.resetSeq")}
        </span>
        <Input
          data-testid="consumer-reset-seq"
          aria-label={t("consumers.resetSeq")}
          inputMode="numeric"
          className="h-8 w-28"
          value={props.resetSeq}
          onChange={(e) => props.onResetSeq(e.target.value)}
        />
        <span className="text-xs text-[var(--fg-faint)]">0 = {t("consumers.resetSeqHint")}</span>
      </div>

      {/* Config echo */}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">{t("consumers.detail.config")}</h3>
        <div className="flex flex-col gap-1 rounded-md border border-border p-3">
          <ConfigRow id="deliver_mode" label={t("consumers.form.deliverMode")} value={f.deliver_mode} />
          {f.deliver_mode === "push" && (
            <>
              <ConfigRow
                id="deliver_subject"
                label={t("consumers.form.deliverSubject")}
                value={f.deliver_subject || "—"}
              />
              <ConfigRow
                id="deliver_group"
                label={t("consumers.form.deliverGroup")}
                value={f.deliver_group || "—"}
              />
            </>
          )}
          <ConfigRow id="deliver_policy" label={t("consumers.form.deliverPolicy")} value={f.deliver_policy} />
          <ConfigRow
            id="filter_subjects"
            label={t("consumers.form.filterSubjects")}
            value={f.filter_subjects?.length ? f.filter_subjects.join(", ") : "—"}
          />
          <ConfigRow id="ack_policy" label={t("consumers.form.ackPolicy")} value={f.ack_policy} />
          <ConfigRow
            id="ack_wait_seconds"
            label={t("consumers.form.ackWait")}
            value={String(f.ack_wait_seconds)}
          />
          <ConfigRow
            id="max_deliver"
            label={t("consumers.form.maxDeliver")}
            value={String(f.max_deliver)}
          />
          <ConfigRow
            id="max_waiting"
            label={t("consumers.form.maxWaiting")}
            value={String(f.max_waiting)}
          />
          <ConfigRow
            id="max_ack_pending"
            label={t("consumers.form.maxAckPending")}
            value={String(f.max_ack_pending)}
          />
          <ConfigRow
            id="max_request_batch"
            label={t("consumers.form.maxRequestBatch")}
            value={String(f.max_request_batch)}
          />
          <ConfigRow
            id="max_request_expires_seconds"
            label={t("consumers.form.maxRequestExpires")}
            value={String(f.max_request_expires_seconds)}
          />
          <ConfigRow
            id="max_request_max_bytes"
            label={t("consumers.form.maxRequestMaxBytes")}
            value={formatBytes(f.max_request_max_bytes ?? 0)}
          />
          <ConfigRow
            id="backoff_seconds"
            label={t("consumers.form.backoff")}
            value={f.backoff_seconds?.length ? f.backoff_seconds.join(", ") : "—"}
          />
          <ConfigRow
            id="replay_policy"
            label={t("consumers.form.replayPolicy")}
            value={f.replay_policy}
          />
          <ConfigRow
            id="inactive_threshold_seconds"
            label={t("consumers.form.inactiveThreshold")}
            value={String(f.inactive_threshold_seconds)}
          />
          <ConfigRow id="replicas" label={t("consumers.form.replicas")} value={String(f.replicas)} />
          <ConfigRow
            id="headers_only"
            label={t("consumers.form.headersOnly")}
            value={f.headers_only ? "yes" : "no"}
          />
          <ConfigRow
            id="memory_storage"
            label={t("consumers.form.memoryStorage")}
            value={f.memory_storage ? "yes" : "no"}
          />
        </div>
      </div>

      {/* Cluster placement */}
      {props.detail.cluster && (
        <div className="flex flex-col gap-1 text-xs">
          <h3 className="text-sm font-medium">{t("consumers.detail.cluster")}</h3>
          <div
            data-testid="consumer-detail-cluster"
            className="flex flex-wrap gap-x-4 gap-y-0.5 rounded-md border border-border px-2.5 py-1.5"
          >
            <span className="font-medium">{props.detail.cluster.name}</span>
            <span className="text-[var(--fg-muted)]">
              {t("consumers.detail.leader")}: {props.detail.cluster.leader || "—"}
            </span>
            {props.detail.cluster.leader === "" && (
              <span className="text-[var(--danger-fg)]">{t("consumers.leaderMissing")}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ConsumersPage;
