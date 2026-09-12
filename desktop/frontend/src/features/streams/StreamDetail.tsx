import { useMemo, useState } from "react";
import { useTranslation } from "../../app/i18n";
import { formatBytes } from "../messages/schema";
import { formatRate } from "./rates";
import { Sparkline } from "./Sparkline";
import type { StreamDetail as StreamDetailModel } from "../../lib/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Sparkline windows (spec §6.6: 5m/15m/1h switch) — 24 points per chart.
const WINDOWS = [
  { key: "5m", ms: 300_000 },
  { key: "15m", ms: 900_000 },
  { key: "1h", ms: 3_600_000 },
] as const;

const SERIES_BUCKETS = 24;

export interface StreamDetailProps {
  detail: StreamDetailModel | null;
  loading: boolean;
  /** Latest msg/s from the detail RateSampler (NaN until the 2nd sample). */
  rate: number;
  /** Bucketed history from the sampler: (windowMs, buckets) → points. */
  series: (windowMs: number, buckets: number) => number[];
  // Operation button slots (Task 10/11/13 inject these; rendered only when
  // provided so this task ships a complete, standalone detail pane).
  onEdit?: () => void;
  onCopy?: () => void;
  onDelete?: () => void;
  onPurge?: () => void;
  onSeal?: () => void;
  onMessages?: () => void;
  onBackup?: () => void;
}

/** ms epoch → local date-time; 0 → "—" (never a bogus 1970 date). */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div
      data-testid={`stream-stat-${id}`}
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-panel px-2.5 py-2"
    >
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
      <span className="truncate text-sm font-medium tabular-nums" title={value}>
        {value}
      </span>
    </div>
  );
}

/**
 * Stream detail pane (spec §6.6): header with storage/retention/kind badges,
 * the stats grid (msgs/bytes/first/last/lost/consumers/deleted), the rate
 * sparkline with a 5m/15m/1h window switch, mirror/sources/cluster sections,
 * and the operation button slots (optional callbacks — Task 10/11/13 inject).
 */
export function StreamDetail({
  detail,
  loading,
  rate,
  series,
  onEdit,
  onCopy,
  onDelete,
  onPurge,
  onSeal,
  onMessages,
  onBackup,
}: StreamDetailProps) {
  const { t } = useTranslation();
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[0].ms);

  const values = useMemo(
    () => series(windowMs, SERIES_BUCKETS),
    // `rate` is a deliberate dependency: a new sample must re-draw the chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, windowMs, rate],
  );

  const ops = [
    { key: "messages", fn: onMessages },
    { key: "edit", fn: onEdit },
    { key: "copy", fn: onCopy },
    { key: "purge", fn: onPurge },
    { key: "seal", fn: onSeal },
    { key: "backup", fn: onBackup },
    { key: "delete", fn: onDelete },
  ] as const;

  if (!detail) return null;
  const s = detail.summary;

  return (
    <div
      data-testid="stream-detail"
      aria-busy={loading}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
    >
      {/* Header: name + badges + operation slots */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold" data-testid="stream-detail-name">
          {s.name}
        </h2>
        {s.description && (
          <span className="truncate text-xs text-[var(--fg-muted)]">{s.description}</span>
        )}
        {s.internal_kind === "kv" && (
          <Badge variant="outline" data-testid="stream-detail-kind">
            {t("streams.kindKv")}
          </Badge>
        )}
        {s.internal_kind === "object" && (
          <Badge variant="outline" data-testid="stream-detail-kind">
            {t("streams.kindObject")}
          </Badge>
        )}
        {s.is_mirror && <Badge variant="secondary">{t("streams.mirror")}</Badge>}
        {s.is_source && <Badge variant="secondary">{t("streams.source")}</Badge>}
        <Badge variant="outline">{s.storage}</Badge>
        <Badge variant="outline">{s.retention}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {ops.map(
            ({ key, fn }) =>
              fn && (
                <Button
                  key={key}
                  size="sm"
                  variant="outline"
                  data-testid={`stream-op-${key}`}
                  onClick={fn}
                >
                  {t(`streams.op.${key}`)}
                </Button>
              ),
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
        <Stat id="msgs" label={t("streams.detail.msgs")} value={String(s.messages)} />
        <Stat id="bytes" label={t("streams.detail.bytes")} value={formatBytes(s.bytes)} />
        <Stat
          id="first"
          label={t("streams.detail.first")}
          value={formatTime(detail.state.first_time_ms)}
        />
        <Stat
          id="last"
          label={t("streams.detail.last")}
          value={formatTime(detail.state.last_time_ms)}
        />
        <Stat id="lost" label={t("streams.detail.lost")} value={String(s.lost_msgs)} />
        <Stat id="consumers" label={t("streams.detail.consumers")} value={String(s.consumers)} />
        <Stat id="deleted" label={t("streams.detail.deleted")} value={String(s.num_deleted)} />
      </div>

      {/* Rate sparkline + window switch */}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-panel p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--fg-muted)]">
            {t("streams.detail.rate")}
          </span>
          <span data-testid="stream-rate" className="text-sm font-medium tabular-nums">
            {rate > 0 || rate < 0
              ? t("streams.rate", { rate: formatRate(rate) })
              : t("streams.noData")}
          </span>
          <div className="ml-auto flex items-center gap-1" role="group" aria-label={t("streams.detail.window")}>
            {WINDOWS.map((w) => (
              <Button
                key={w.key}
                size="sm"
                variant={windowMs === w.ms ? "default" : "outline"}
                aria-pressed={windowMs === w.ms}
                data-testid={`stream-window-${w.key}`}
                onClick={() => setWindowMs(w.ms)}
                className="h-6 px-2 text-xs"
              >
                {t(`streams.detail.window${w.key}`)}
              </Button>
            ))}
          </div>
        </div>
        <Sparkline
          values={values}
          width={320}
          height={48}
          ariaLabel={
            !Number.isNaN(rate) && rate !== 0
              ? t("streams.detail.rateTitle", { rate: formatRate(rate) })
              : t("streams.detail.noRateData")
          }
        />
      </div>

      {/* Mirror / sources */}
      {(detail.mirror || detail.sources.length > 0) && (
        <div className="flex flex-col gap-1 text-xs">
          <h3 className="text-sm font-medium">{t("streams.detail.sources")}</h3>
          {detail.mirror && (
            <div data-testid="stream-detail-mirror" className="flex flex-wrap gap-x-4 gap-y-0.5 rounded-md border border-border px-2.5 py-1.5">
              <span className="font-medium">
                {t("streams.detail.mirror")}: {detail.mirror.name}
              </span>
              <span className="text-[var(--fg-muted)]">
                {t("streams.detail.lag")}: {detail.mirror.lag}
              </span>
            </div>
          )}
          {detail.sources.map((src) => (
            <div
              key={src.name}
              data-testid="stream-detail-source"
              className="flex flex-wrap gap-x-4 gap-y-0.5 rounded-md border border-border px-2.5 py-1.5"
            >
              <span className="font-medium">{src.name}</span>
              <span className="text-[var(--fg-muted)]">
                {t("streams.detail.lag")}: {src.lag}
              </span>
              {src.filter_subject && (
                <span className="font-mono text-[var(--fg-muted)]">{src.filter_subject}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Cluster placement */}
      {detail.cluster && (
        <div className="flex flex-col gap-1 text-xs">
          <h3 className="text-sm font-medium">{t("streams.detail.cluster")}</h3>
          <div
            data-testid="stream-detail-cluster"
            className="flex flex-wrap gap-x-4 gap-y-0.5 rounded-md border border-border px-2.5 py-1.5"
          >
            <span className="font-medium">{detail.cluster.name}</span>
            <span className="text-[var(--fg-muted)]">
              {t("streams.detail.leader")}: {detail.cluster.leader || "—"}
            </span>
            <span className="text-[var(--fg-muted)]">
              {t("streams.detail.peers")}: {detail.cluster.peers.length}
            </span>
            {detail.cluster.leader === "" && (
              <span className="text-[var(--danger-fg)]">{t("streams.leaderMissing")}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
