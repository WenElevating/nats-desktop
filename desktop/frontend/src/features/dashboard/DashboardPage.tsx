import { useMemo } from "react";
import {
  BellRing,
  Cable,
  ChevronRight,
  Database,
  MemoryStick,
  Server,
  ShieldOff,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { formatBytes } from "../../lib/format";
import type { MonitorServerRow } from "../../lib/bindings";
import { useMonitor } from "../monitoring/useMonitor";
import { AdvisoryList } from "./AdvisoryList";
import type { PageId } from "../../app/shell";

// ---------------------------------------------------------------------------
// Dashboard overview page (spec §6.5). Data flows entirely from Task 10's
// useMonitor — mounting the page is what starts the Go poll loop (leaving
// stops it); this page adds no poller of its own. The card group aggregates
// the latest snapshot (servers online/total, Σ connections, the two JS
// usage ratios, RTT) and every card navigates to the page that manages it
// (Monitoring for fleet/latency, Streams for JetStream capacity). Without
// $SYS permission (sys_available=false) the whole card group is replaced by
// the noPermission explanation card and the advisory list degrades to the
// same copy — per §6.5 the rest of the page is unaffected.
// ---------------------------------------------------------------------------

/** Aggregated card inputs derived from one snapshot's server rows. */
export interface DashAggregates {
  online: number;
  total: number;
  offline: number;
  /** Σ per-server current connections. */
  connections: number;
  jsMemUsed: number;
  jsMemMax: number;
  /** Σ used / Σ max over servers with a set limit; null when max is 0. */
  jsMemRatio: number | null;
  jsStoreUsed: number;
  jsStoreMax: number;
  jsStoreRatio: number | null;
}

/**
 * Card aggregation (§6.5): online/total from the rows' online flag,
 * connections = Σ connections, JS ratios = Σ used / Σ max. Go maps an unset
 * JetStream limit to -1 (unlimited) — clamped to 0 first so an unlimited
 * server neither poisons the sum nor pretends to be capacity; a 0 denominator
 * yields null (rendered as "-", never NaN/∞).
 */
export function aggregate(
  servers: readonly MonitorServerRow[] | null | undefined,
): DashAggregates {
  let online = 0;
  let connections = 0;
  let memUsed = 0;
  let memMax = 0;
  let storeUsed = 0;
  let storeMax = 0;
  for (const s of servers ?? []) {
    if (s.online) online++;
    connections += s.connections;
    memUsed += Math.max(0, s.js_memory_bytes);
    memMax += Math.max(0, s.js_max_memory_bytes);
    storeUsed += Math.max(0, s.js_store_bytes);
    storeMax += Math.max(0, s.js_max_store_bytes);
  }
  const total = servers?.length ?? 0;
  return {
    online,
    total,
    offline: total - online,
    connections,
    jsMemUsed: memUsed,
    jsMemMax: memMax,
    jsMemRatio: memMax > 0 ? memUsed / memMax : null,
    jsStoreUsed: storeUsed,
    jsStoreMax: storeMax,
    jsStoreRatio: storeMax > 0 ? storeUsed / storeMax : null,
  };
}

/**
 * The fresher of the two RTT samples (§6.5: conn.rttMs 与快照 rtt_ms 取新).
 * The snapshot's rtt_ms is re-measured by every poll cycle (nc.RTT), while
 * conn.rttMs only refreshes on connection state transitions — so a non-zero
 * snapshot sample always wins, and the conn sample covers the window before
 * the first snapshot. 0 on both = not measured → null (rendered as "-").
 */
export function pickRtt(connMs: number, snapMs: number): number | null {
  if (snapMs > 0) return snapMs;
  if (connMs > 0) return connMs;
  return null;
}

export interface DashboardPageProps {
  /** Shell navigation seam (App holds the page state): cards jump to the
   * page that manages what they summarize. */
  onNavigate?: (page: PageId) => void;
}

/** One metric card: label row (icon + label + hover chevron) + value slot. */
function Card({
  testid,
  icon: Icon,
  label,
  title,
  onClick,
  children,
}: {
  testid: string;
  icon: LucideIcon;
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      title={title}
      onClick={onClick}
      className="group flex min-w-0 flex-col items-start gap-1.5 rounded-lg border border-border bg-panel px-3 py-2.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
    >
      <span className="flex w-full items-center gap-1.5 text-xs text-[var(--fg-muted)]">
        <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          aria-hidden="true"
          className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        />
      </span>
      {children}
    </button>
  );
}

const bigValue = "font-mono text-2xl tabular-nums leading-7";

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { t } = useTranslation();
  const conn = useConnState();
  // Task 10 reuse: mount → StartMonitoring, unmount → StopMonitoring (the
  // hook owns the Go loop's lifetime; this page adds no poller).
  const mon = useMonitor();
  const snap = mon.snapshot;
  const degraded = snap !== null && !mon.sysAvailable;

  const agg = useMemo(() => aggregate(snap?.servers), [snap]);
  const rtt = pickRtt(conn.rttMs, snap?.rtt_ms ?? 0);
  const goto = (page: PageId) => () => onNavigate?.(page);

  const ratioCard = (
    id: "js-memory" | "js-store",
    ratio: number | null,
    used: number,
    max: number,
  ) => {
    // aria-valuenow must stay within [0, 100] (M6 Task 8 ㉜): used can exceed
    // max on a real server (reserved > limit), which would emit 100+.
    const pct = ratio === null ? null : Math.min(100, Math.max(0, Math.round(ratio * 100)));
    return (
      <Card
        testid={`dash-card-${id}`}
        icon={id === "js-memory" ? MemoryStick : Database}
        label={t(id === "js-memory" ? "dashboard.jsMemory" : "dashboard.jsStore")}
        title={t("dashboard.openStreams")}
        onClick={goto("streams")}
      >
        {pct === null ? (
          <span data-testid={`dash-${id}-value`} className={bigValue}>
            -
          </span>
        ) : (
          <>
            <span data-testid={`dash-${id}-value`} className={bigValue}>
              {pct}%
            </span>
            <span
              data-testid={`dash-${id}-bar`}
              data-pct={String(pct)}
              className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-soft)]"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                className="block h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="text-[11px] tabular-nums text-[var(--fg-muted)]">
              {formatBytes(used)} / {formatBytes(max)}
            </span>
          </>
        )}
      </Card>
    );
  };

  return (
    <div data-testid="page-dashboard" className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      {/* Card group — or its §6.5 degradation / first-snapshot waiting state */}
      {snap === null ? (
        <p data-testid="dash-waiting" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("dashboard.waiting")}
        </p>
      ) : degraded ? (
        <div
          data-testid="dashboard-no-permission"
          className="flex shrink-0 flex-col items-start gap-1 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-[var(--warn-fg)]">
            <ShieldOff size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("dashboard.noPermission")}
          </p>
          <p className="text-xs text-[var(--fg-muted)]">{t("dashboard.noPermissionBody")}</p>
        </div>
      ) : (
        <div data-testid="dash-cards" className="grid shrink-0 grid-cols-2 gap-2 xl:grid-cols-5">
          <Card
            testid="dash-card-servers"
            icon={Server}
            label={t("dashboard.servers")}
            title={t("dashboard.openMonitoring")}
            onClick={goto("monitoring")}
          >
            <span data-testid="dash-servers-value" className={bigValue}>
              {agg.online}/{agg.total}
            </span>
            {agg.offline > 0 && (
              <span
                data-testid="dash-servers-offline"
                className="flex items-center gap-1.5 text-xs text-[var(--danger-fg)]"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-[var(--danger)]" aria-hidden="true" />
                {t("dashboard.serversOffline", { n: agg.offline })}
              </span>
            )}
          </Card>
          <Card
            testid="dash-card-connections"
            icon={Cable}
            label={t("dashboard.connections")}
            title={t("dashboard.openMonitoring")}
            onClick={goto("monitoring")}
          >
            <span data-testid="dash-connections-value" className={bigValue}>
              {agg.connections.toLocaleString("en-US")}
            </span>
          </Card>
          {ratioCard("js-memory", agg.jsMemRatio, agg.jsMemUsed, agg.jsMemMax)}
          {ratioCard("js-store", agg.jsStoreRatio, agg.jsStoreUsed, agg.jsStoreMax)}
          <Card
            testid="dash-card-rtt"
            icon={Timer}
            label={t("dashboard.rtt")}
            title={t("dashboard.openMonitoring")}
            onClick={goto("monitoring")}
          >
            <span data-testid="dash-rtt-value" className={bigValue}>
              {rtt === null ? "-" : `${rtt} ms`}
            </span>
          </Card>
        </div>
      )}

      {/* Recent advisories (§6.5): newest-first 100-entry ring; degrades to
          the same explanation when $SYS is unavailable. */}
      <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-panel">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium">
          <BellRing size={14} strokeWidth={1.75} aria-hidden="true" />
          {t("dashboard.advisory.title")}
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-1">
          <AdvisoryList degraded={degraded} />
        </div>
      </section>
    </div>
  );
}

export default DashboardPage;
