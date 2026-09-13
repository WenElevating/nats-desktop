import { useState } from "react";
import { Pause, Play, RefreshCw, ShieldOff } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { useMonitor } from "./useMonitor";
import { ServerTable } from "./ServerTable";
import { NodeDetail } from "./NodeDetail";
import { ConnectionsTop } from "./ConnectionsTop";
import { AccountsPanel } from "./AccountsPanel";
import { Button } from "@/components/ui/button";

// Task 11 ships the node/connections/accounts panels; events + the danger
// zone land in Task 12 and stay disabled placeholders until then.
const TABS = ["node", "connections", "events", "accounts", "danger"] as const;
type TabId = (typeof TABS)[number];
const DISABLED_TABS: readonly TabId[] = ["events", "danger"];

/**
 * Monitoring page shell (spec §6.10): toolbar (interval chip, pause/resume,
 * refresh-now), the permission-degradation banner (sys_available=false →
 * ShieldOff + guidance + expandable reason原文), the virtualized server
 * table, and the lower tab area — the per-server node report, the paginated
 * connections table and the cluster accounts panel. The Go side owns the
 * snapshot poll loop — the lower panels are on-demand reports with manual
 * refresh only, so there is no frontend timer anywhere on this page.
 */
export function MonitoringPage() {
  const { t } = useTranslation();
  const conn = useConnState();
  const mon = useMonitor();
  const snap = mon.snapshot;
  const connected = conn.state === "connected";
  const [tab, setTab] = useState<TabId>("node");

  return (
    // data-polled-at is the Task 14 UIA anchor for the two-cycle refresh
    // assertion (mirrored on the ServerTable root).
    <div
      data-testid="monitoring-page"
      data-polled-at={snap ? String(snap.polled_at_ms) : undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Toolbar */}
      <div
        data-testid="monitor-toolbar"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3"
      >
        <span
          data-testid="monitor-interval"
          title={t("monitor.interval")}
          className="font-mono text-xs tabular-nums text-[var(--fg-muted)]"
        >
          {mon.intervalSeconds}s
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          data-testid="monitor-pause"
          aria-label={mon.paused ? t("monitor.resumed") : t("monitor.paused")}
          title={mon.paused ? t("monitor.resumed") : t("monitor.paused")}
          onClick={() => mon.setPaused(!mon.paused)}
          disabled={!connected}
          className="h-8 shrink-0 px-2"
        >
          {mon.paused ? (
            <Play size={14} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Pause size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="monitor-refresh"
          aria-label={t("monitor.refresh")}
          title={t("monitor.refresh")}
          onClick={() => void mon.refreshNow()}
          disabled={!connected || mon.paused}
          className="h-8 shrink-0 px-2"
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>

      {/* Permission degradation (§6.10 失败面): partial permissions are not an
          error — guidance + the expandable server原文 (sys_reason). */}
      {snap !== null && !mon.sysAvailable && (
        <details
          data-testid="monitor-no-permission"
          className="mx-3 mt-2 shrink-0 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm"
        >
          <summary className="flex cursor-pointer items-center gap-2 font-medium text-[var(--warn-fg)]">
            <ShieldOff size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("monitor.noPermission")}
          </summary>
          <p className="mt-1 break-all text-xs text-[var(--fg-muted)]">
            {mon.sysReason || t("monitor.showReason")}
          </p>
        </details>
      )}

      {/* Server table */}
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-2">
        <ServerTable snapshot={snap} selected={mon.selected} onSelect={mon.setSelected} />
      </div>

      {/* Lower tab area: the on-demand report panels (Task 11) + the Task 12
          placeholders. A fixed-height strip keeps the server table dominant
          while every panel scrolls internally. */}
      <div className="flex h-64 shrink-0 flex-col border-t border-border px-3 py-2">
        <div role="tablist" aria-label={t("monitor.label")} className="flex shrink-0 gap-1">
          {TABS.map((id) => {
            const disabled = DISABLED_TABS.includes(id);
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                data-testid={`monitor-tab-${id}`}
                aria-selected={active}
                disabled={disabled}
                title={disabled ? t("monitor.tabPlaceholder") : undefined}
                onClick={() => setTab(id)}
                className={`rounded-md px-2.5 py-1 text-xs ${
                  active
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                    : "text-[var(--fg-muted)] hover:text-foreground"
                } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
              >
                {t(`monitor.tab.${id}`)}
              </button>
            );
          })}
        </div>
        <div data-testid="monitor-panel" className="mt-1 min-h-0 flex-1 overflow-hidden">
          {tab === "node" ? (
            <NodeDetail server={mon.selected} />
          ) : tab === "connections" ? (
            <ConnectionsTop server={mon.selected} />
          ) : tab === "accounts" ? (
            <AccountsPanel />
          ) : (
            <p className="p-4 text-xs text-[var(--fg-faint)]">{t("monitor.tabPlaceholder")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default MonitoringPage;
