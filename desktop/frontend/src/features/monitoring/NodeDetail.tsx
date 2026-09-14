import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Stethoscope } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { GetServerDetail, type ServerDetail } from "../../lib/bindings";
import { formatBytes } from "../../lib/format";
import { formatUptime } from "./ServerTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Max-limits cell: Go maps an unset JS limit to -1 (unlimited). */
function formatLimit(n: number, unlimited: string): string {
  return n < 0 ? unlimited : formatBytes(n);
}

const num = (v: number | bigint): string => Number(v).toLocaleString("en-US");

export interface NodeDetailProps {
  /** Selected server NAME (from useMonitor). */
  server: string | null;
}

/**
 * Per-server report card (spec §6.10 按需展开, Global 3): varz stats (cpu/
 * memory/cores/subs/leafnodes/traffic counters/uptime/start), the JetStream
 * config echo (role badge, streams/consumers, max memory/store), and the
 * healthz badge (ok green / err red with the expandable health_detail 原文).
 * A panel-level failure (res.error_code non-empty — e.g. varz needs system
 * privileges) hides the report and renders the server's原文 in an error card;
 * other panels stay unaffected. Manual refresh only — this is an on-demand
 * report, not a polled one.
 */
export function NodeDetail({ server }: NodeDetailProps) {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // Mid-flight guard (useConsumers 同款): only the newest answer lands.
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!server || !connected) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const res = await GetServerDetail(server);
      if (seq.current !== my) return; // selection moved on mid-flight
      if (res?.error_code) {
        // Global 3: the rejected report is hidden, the 原文 explains.
        setDetail(null);
        setErr(res.error || res.error_code);
      } else {
        setErr("");
        setDetail(res?.detail ?? null);
      }
    } catch (e) {
      if (seq.current !== my) return;
      setDetail(null);
      setErr(errText(e));
    } finally {
      if (seq.current === my) setLoading(false);
    }
  }, [server, connected]);

  // On-demand: fetch on selection change (and reconnect), never on a timer.
  useEffect(() => {
    if (!server || !connected) {
      setDetail(null);
      setErr("");
      return;
    }
    void load();
  }, [server, connected, load]);

  if (!server) {
    return (
      <p data-testid="node-empty" className="p-4 text-sm text-[var(--fg-muted)]">
        {t("monitor.node.empty")}
      </p>
    );
  }

  // Panel-level failure: error card with the server原文 + a retry button that
  // reuses the refresh entry (M6 Task 8 ㉓ — a rejected report is often a
  // transient privilege/timeout, so the card must offer a direct way out).
  if (err) {
    return (
      <div
        data-testid="node-error"
        className="m-1 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm"
      >
        <p className="font-medium text-[var(--danger-fg)]">{t("monitor.node.errorTitle")}</p>
        <p className="mt-1 break-all text-xs text-[var(--fg-muted)]">{err}</p>
        <Button
          size="sm"
          variant="outline"
          data-testid="node-error-retry"
          onClick={() => void load()}
          disabled={loading || !connected}
          className="mt-2 h-7 shrink-0 px-2"
        >
          {loading ? (
            <Loader2 size={13} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
          )}
          {t("monitor.node.retry")}
        </Button>
      </div>
    );
  }

  if (!detail) {
    return (
      <p data-testid="node-loading" className="p-4 text-sm text-[var(--fg-muted)]">
        {loading ? t("monitor.node.loading") : t("monitor.node.empty")}
      </p>
    );
  }

  const r = detail.row;
  const health = detail.health_status;

  /** Stat cell: label over a monospaced tabular value (§18.2). */
  const stat = (id: string, label: string, value: string) => (
    <div data-testid={`node-stat-${id}`} className="min-w-0">
      <p className="truncate text-[10px] uppercase tracking-wide text-[var(--fg-faint)]">
        {label}
      </p>
      <p className="truncate font-mono text-sm tabular-nums">{value}</p>
    </div>
  );

  return (
    <div data-testid="node-detail" className="flex min-h-0 flex-col">
      {/* Panel header: server name + manual refresh (no polling — §6.10). */}
      <div className="flex shrink-0 items-center gap-2">
        <h3 className="truncate text-sm font-medium">
          {r.name}
          <span className="ml-2 text-xs font-normal text-[var(--fg-muted)]">
            {r.host} · {r.version}
          </span>
        </h3>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          data-testid="node-refresh"
          aria-label={t("monitor.node.refresh")}
          title={t("monitor.node.refresh")}
          onClick={() => void load()}
          disabled={loading || !connected}
          className="h-7 shrink-0 px-2"
        >
          {loading ? (
            <Loader2 size={13} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
          )}
        </Button>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-auto">
        {/* healthz badge: ok → green, error → red + expandable 原文. */}
        <div className="flex items-center gap-2">
          <Badge
            data-testid="node-health"
            data-status={health === "ok" ? "ok" : health === "error" ? "error" : "unknown"}
            className={
              health === "ok"
                ? "bg-[var(--ok-soft)] px-1.5 py-0 text-[10px] text-[var(--ok-fg)]"
                : health === "error"
                  ? "bg-[var(--danger-soft)] px-1.5 py-0 text-[10px] text-[var(--danger-fg)]"
                  : "px-1.5 py-0 text-[10px]"
            }
            variant={health === "" ? "outline" : "secondary"}
          >
            <Stethoscope size={11} strokeWidth={1.75} aria-hidden="true" />
            {t(
              health === "ok"
                ? "monitor.node.healthOk"
                : health === "error"
                  ? "monitor.node.healthError"
                  : "monitor.node.healthUnknown",
            )}
            {health === "error" && detail.health_error ? ` · ${detail.health_error}` : ""}
          </Badge>
        </div>
        {health === "error" && detail.health_detail ? (
          <details data-testid="node-health-detail" className="mt-1 text-xs">
            <summary className="cursor-pointer text-[var(--fg-muted)]">
              {t("monitor.node.healthDetail")}
            </summary>
            <p className="mt-1 break-all whitespace-pre-wrap text-[var(--fg-muted)]">
              {detail.health_detail}
            </p>
          </details>
        ) : null}

        {/* varz stats grid */}
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-x-3 gap-y-2">
          {stat("cpu", t("monitor.node.stat.cpu"), `${r.cpu.toFixed(1)}%`)}
          {stat("mem", t("monitor.node.stat.mem"), formatBytes(r.mem_bytes))}
          {stat("cores", t("monitor.node.stat.cores"), num(r.cores))}
          {stat("conns", t("monitor.node.stat.conns"), num(r.connections))}
          {stat("subs", t("monitor.node.stat.subs"), num(detail.num_subs))}
          {stat("leaf", t("monitor.node.stat.leaf"), num(detail.leaf_nodes))}
          {stat("sent-msgs", t("monitor.node.stat.sentMsgs"), num(detail.sent_msgs))}
          {stat("sent-bytes", t("monitor.node.stat.sentBytes"), formatBytes(detail.sent_bytes))}
          {stat("recv-msgs", t("monitor.node.stat.recvMsgs"), num(detail.recv_msgs))}
          {stat("recv-bytes", t("monitor.node.stat.recvBytes"), formatBytes(detail.recv_bytes))}
          {stat("uptime", t("monitor.node.stat.uptime"), formatUptime(r.uptime_seconds))}
          {stat(
            "start",
            t("monitor.node.stat.start"),
            detail.start_ms > 0 ? new Date(detail.start_ms).toLocaleString() : "—",
          )}
        </div>

        {/* JetStream config echo */}
        <div
          data-testid="node-js"
          className="mt-3 rounded-md border border-border px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium">{t("monitor.node.js.title")}</p>
            {r.js_role === "meta_leader" ? (
              <Badge className="bg-[var(--accent-soft)] px-1.5 py-0 text-[10px] text-[var(--accent-strong)]">
                {t("monitor.role.metaLeader")}
              </Badge>
            ) : r.js_enabled && r.js_role === "voter" ? (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {t("monitor.role.voter")}
              </Badge>
            ) : (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {t("monitor.role.disabled")}
              </Badge>
            )}
            <span className="ml-auto font-mono text-xs tabular-nums text-[var(--fg-muted)]">
              {t("monitor.node.js.streams")} {num(r.js_streams)} ·{" "}
              {t("monitor.node.js.consumers")} {num(r.js_consumers)}
            </span>
          </div>
          <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-3 text-xs">
            <p className="min-w-0 font-mono tabular-nums">
              <span className="font-sans text-[var(--fg-muted)]">
                {t("monitor.node.js.maxMemory")}
              </span>{" "}
              {formatLimit(r.js_max_memory_bytes, t("monitor.node.js.unlimited"))}
            </p>
            <p className="min-w-0 font-mono tabular-nums">
              <span className="font-sans text-[var(--fg-muted)]">
                {t("monitor.node.js.maxStore")}
              </span>{" "}
              {formatLimit(r.js_max_store_bytes, t("monitor.node.js.unlimited"))}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
