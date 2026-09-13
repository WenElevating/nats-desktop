import { useCallback, useEffect, useMemo, useRef, useState, type AriaAttributes } from "react";
import { Loader2, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { useConfirm } from "../../lib/confirm";
import {
  KickConnection,
  ListServerConnections,
  type ConnRow,
} from "../../lib/bindings";
import { formatBytes } from "../messages/schema";
import { Button } from "@/components/ui/button";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Column template shared by the header row and the body rows (ServerTable
 * 同款). The user column takes the rest; the fixed tracks sum to 894px, so the
 * 14-track grid scrolls horizontally inside narrow panels (min-w below).
 */
export const CONN_GRID_COLS =
  "grid-cols-[56px_120px_minmax(0,1fr)_88px_44px_56px_64px_64px_76px_76px_72px_64px_56px_40px]";

/** nats-server SortOpt subset accepted by the Go binding (Global 11). */
const SORT_KEYS = [
  "cid",
  "subs",
  "pending",
  "msgs_to",
  "msgs_from",
  "bytes_to",
  "bytes_from",
  "idle",
  "uptime",
  "rtt",
] as const;
type ConnSortKey = (typeof SORT_KEYS)[number];

const LIMITS = [20, 50, 100] as const;

interface ConnQuery {
  sortKey: ConnSortKey;
  offset: number;
  limit: number;
}

const DEFAULT_QUERY: ConnQuery = { sortKey: "cid", offset: 0, limit: 20 };

export interface ConnectionsTopProps {
  /** Selected server NAME (from useMonitor). */
  server: string | null;
}

/**
 * Server-directed connection table (spec §6.10 / brief): offset paging with a
 * 20/50/100 limit select, header-click sorting (ServerTable interaction,
 * Global 16) over the whitelisted keys, and a per-row kick button (Unplug,
 * L1 confirm → KickConnection). The sort key passes through to the server;
 * the Go whitelist (Global 11) accepts bare keys only, so a repeated click on
 * the active column flips the direction within the fetched page locally.
 * Manual refresh only — connz is an on-demand report, never polled.
 */
export function ConnectionsTop({ server }: ConnectionsTopProps) {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";
  const { confirmL1 } = useConfirm();

  const [query, setQuery] = useState<ConnQuery>(DEFAULT_QUERY);
  const [desc, setDesc] = useState(false);
  const [rows, setRows] = useState<ConnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [kickingCid, setKickingCid] = useState<number | null>(null);

  // Mid-flight guard (useConsumers 同款): only the newest answer lands.
  const seq = useRef(0);

  // Selection change: full reset before the fetch effect re-runs (the React
  // sanctioned render-time derived-state reset — one consistent fetch).
  const [prevServer, setPrevServer] = useState(server);
  if (prevServer !== server) {
    setPrevServer(server);
    setQuery(DEFAULT_QUERY);
    setDesc(false);
    setRows([]);
    setTotal(0);
    setErr("");
  }

  const load = useCallback(
    async (srv: string, q: ConnQuery) => {
      const my = ++seq.current;
      setLoading(true);
      try {
        const res = await ListServerConnections(srv, q.sortKey, q.offset, q.limit);
        if (seq.current !== my) return; // paging/sort/selection moved on
        if (res?.error_code) {
          setErr(res.error || res.error_code);
          setRows([]);
          setTotal(0);
        } else {
          setErr("");
          setRows(res?.rows ?? []);
          setTotal(res?.total ?? 0);
        }
      } catch (e) {
        if (seq.current !== my) return;
        setRows([]);
        setTotal(0);
        toast.error(t("monitor.conn.loadFailed", { error: errText(e) }));
      } finally {
        if (seq.current === my) setLoading(false);
      }
    },
    [t],
  );

  // On-demand fetch: selection / page / sort / limit change (never a timer).
  useEffect(() => {
    if (!server || !connected) {
      setRows([]);
      setTotal(0);
      setErr("");
      return;
    }
    void load(server, query);
  }, [server, connected, query, load]);

  const onSort = (key: ConnSortKey) => {
    if (key === query.sortKey) {
      setDesc((d) => !d); // local flip within the fetched page
      return;
    }
    setDesc(false);
    setQuery((q) => ({ ...q, sortKey: key, offset: 0 }));
  };

  const refresh = () => {
    if (server && connected) void load(server, query);
  };

  /** L1-gated kick (Global 4): confirm → binding → toast + page refresh. */
  const kick = async (row: ConnRow) => {
    if (!server || !connected) return;
    const ok = await confirmL1({
      titleKey: "monitor.conn.kickTitle",
      bodyKey: "monitor.conn.kickBody",
      data: { cid: String(row.cid), server },
    });
    if (!ok) return;
    setKickingCid(row.cid);
    try {
      const res = await KickConnection(server, row.cid);
      if (!res?.error_code) {
        toast.success(t("monitor.conn.kicked", { cid: row.cid }));
        void load(server, query);
      } else {
        toast.error(t("monitor.conn.kickFailed", { error: res.error || res.error_code }));
      }
    } catch (e) {
      toast.error(t("monitor.conn.kickFailed", { error: errText(e) }));
    } finally {
      setKickingCid(null);
    }
  };

  const displayRows = useMemo(() => (desc ? [...rows].reverse() : rows), [rows, desc]);

  /** Sortable header cell: button + aria-sort for the active column. */
  const sortHead = (key: ConnSortKey, label: string, align?: "right") => ({
    "aria-sort": (query.sortKey === key
      ? desc
        ? "descending"
        : "ascending"
      : undefined) as AriaAttributes["aria-sort"],
    "data-testid": `conn-col-${key}`,
    className:
      align === "right"
        ? "min-w-0 overflow-hidden whitespace-nowrap text-right"
        : "min-w-0 overflow-hidden whitespace-nowrap",
    children: (
      <button
        type="button"
        data-testid={`conn-sort-${key}`}
        onClick={() => onSort(key)}
        className="flex items-center gap-0.5 text-xs font-medium text-[var(--fg-muted)] hover:text-foreground"
      >
        {label}
        {query.sortKey === key ? (desc ? " ↓" : " ↑") : ""}
      </button>
    ),
  });

  const num = (n: number): string => n.toLocaleString("en-US");

  return (
    <div data-testid="conn-panel" className="flex min-h-0 flex-col">
      {/* Panel header: total count + limit select + manual refresh. */}
      <div className="flex shrink-0 items-center gap-2">
        <p className="text-xs text-[var(--fg-muted)]">
          {t("monitor.conn.totalLabel")}{" "}
          <span data-testid="conn-total" className="font-mono tabular-nums">
            {num(total)}
          </span>
        </p>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-[var(--fg-muted)]">
          {t("monitor.conn.limit")}
          <select
            data-testid="conn-limit"
            aria-label={t("monitor.conn.limit")}
            value={query.limit}
            onChange={(e) =>
              setQuery((q) => ({ ...q, limit: Number(e.target.value), offset: 0 }))
            }
            className="h-7 rounded-md border border-border bg-transparent px-1 text-xs"
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          data-testid="conn-refresh"
          aria-label={t("monitor.conn.refresh")}
          title={t("monitor.conn.refresh")}
          onClick={refresh}
          disabled={loading || !server || !connected}
          className="h-7 shrink-0 px-2"
        >
          {loading ? (
            <Loader2 size={13} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
          )}
        </Button>
      </div>

      {!server ? (
        <p data-testid="conn-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("monitor.conn.noServer")}
        </p>
      ) : err ? (
        // Panel-level failure: error card with the server原文.
        <div
          data-testid="conn-error"
          className="m-1 mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm"
        >
          <p className="font-medium text-[var(--danger-fg)]">{t("monitor.conn.errorTitle")}</p>
          <p className="mt-1 break-all text-xs text-[var(--fg-muted)]">{err}</p>
        </div>
      ) : (
        <div className="mt-1 min-h-0 flex-1 overflow-auto">
          <div className="min-w-[960px]">
            {/* Header row sharing CONN_GRID_COLS with the body rows. */}
            <div
              data-testid="conn-table"
              role="table"
              className={`grid h-8 items-center border-b border-border text-xs ${CONN_GRID_COLS} px-2`}
            >
              <div role="columnheader" {...sortHead("cid", t("monitor.conn.col.cid"))} />
              <div
                role="columnheader"
                className="min-w-0 overflow-hidden whitespace-nowrap text-xs font-medium text-[var(--fg-muted)]"
              >
                {t("monitor.conn.col.ip")}
              </div>
              <div
                role="columnheader"
                className="min-w-0 overflow-hidden whitespace-nowrap text-xs font-medium text-[var(--fg-muted)]"
              >
                {t("monitor.conn.col.user")}
              </div>
              <div
                role="columnheader"
                className="min-w-0 overflow-hidden whitespace-nowrap text-xs font-medium text-[var(--fg-muted)]"
              >
                {t("monitor.conn.col.account")}
              </div>
              <div role="columnheader" {...sortHead("subs", t("monitor.conn.col.subs"), "right")} />
              <div
                role="columnheader"
                {...sortHead("pending", t("monitor.conn.col.pending"), "right")}
              />
              <div
                role="columnheader"
                {...sortHead("msgs_from", t("monitor.conn.col.inMsgs"), "right")}
              />
              <div
                role="columnheader"
                {...sortHead("msgs_to", t("monitor.conn.col.outMsgs"), "right")}
              />
              <div
                role="columnheader"
                {...sortHead("bytes_from", t("monitor.conn.col.inBytes"), "right")}
              />
              <div
                role="columnheader"
                {...sortHead("bytes_to", t("monitor.conn.col.outBytes"), "right")}
              />
              <div
                role="columnheader"
                {...sortHead("uptime", t("monitor.conn.col.uptime"), "right")}
              />
              <div role="columnheader" {...sortHead("idle", t("monitor.conn.col.idle"), "right")} />
              <div role="columnheader" {...sortHead("rtt", t("monitor.conn.col.rtt"), "right")} />
              <div role="columnheader" className="min-w-0" />
            </div>
            {displayRows.length === 0 ? (
              <p data-testid="conn-empty" className="p-4 text-sm text-[var(--fg-muted)]">
                {t("monitor.conn.empty")}
              </p>
            ) : (
              displayRows.map((r) => (
              <div
                key={r.cid}
                data-testid={`conn-row-${r.cid}`}
                role="row"
                className={`grid ${CONN_GRID_COLS} w-full items-center px-2 py-1 text-xs hover:bg-[var(--border-soft)]`}
              >
                <span className="truncate font-mono tabular-nums">{r.cid}</span>
                <span className="truncate text-[var(--fg-muted)]" title={`${r.ip}:${r.port}`}>
                  {r.ip ? `${r.ip}:${r.port}` : "—"}
                </span>
                <span className="truncate" title={r.user || r.name}>
                  {r.user || r.name || "—"}
                </span>
                <span className="truncate text-[var(--fg-muted)]" title={r.account}>
                  {r.account || "—"}
                </span>
                <span className="text-right font-mono tabular-nums">{num(r.num_subs)}</span>
                <span className="text-right font-mono tabular-nums">{num(r.pending)}</span>
                <span className="text-right font-mono tabular-nums">{num(r.in_msgs)}</span>
                <span className="text-right font-mono tabular-nums">{num(r.out_msgs)}</span>
                <span className="text-right font-mono tabular-nums">{formatBytes(r.in_bytes)}</span>
                <span className="text-right font-mono tabular-nums">
                  {formatBytes(r.out_bytes)}
                </span>
                <span className="text-right font-mono tabular-nums">{r.uptime || "—"}</span>
                <span className="text-right font-mono tabular-nums">{r.idle || "—"}</span>
                <span className="text-right font-mono tabular-nums">{r.rtt || "—"}</span>
                <span className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`conn-kick-${r.cid}`}
                    aria-label={t("monitor.conn.kickTitle", { cid: r.cid })}
                    title={t("monitor.conn.kickTitle", { cid: r.cid })}
                    onClick={() => void kick(r)}
                    disabled={kickingCid !== null || !connected}
                    className="h-6 shrink-0 px-1.5"
                  >
                    {kickingCid === r.cid ? (
                      <Loader2
                        size={12}
                        strokeWidth={1.75}
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Unplug size={12} strokeWidth={1.75} aria-hidden="true" />
                    )}
                  </Button>
                </span>
              </div>
            ))
            )}
          </div>
        </div>
      )}

      {/* Paging footer */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border pt-1">
        <Button
          size="sm"
          variant="outline"
          data-testid="conn-prev"
          aria-label={t("monitor.conn.prev")}
          onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - q.limit) }))}
          disabled={query.offset === 0 || loading || !server}
          className="h-7 px-2 text-xs"
        >
          {t("monitor.conn.prev")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="conn-next"
          aria-label={t("monitor.conn.next")}
          onClick={() => setQuery((q) => ({ ...q, offset: q.offset + q.limit }))}
          disabled={query.offset + query.limit >= total || loading || !server}
          className="h-7 px-2 text-xs"
        >
          {t("monitor.conn.next")}
        </Button>
      </div>
    </div>
  );
}
