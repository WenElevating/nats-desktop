import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { ListAccounts, type AccountRow } from "../../lib/bindings";
import { formatBytes } from "../../lib/format";
import { Button } from "@/components/ui/button";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const num = (n: number): string => n.toLocaleString("en-US");

/**
 * Cluster-wide account cards (spec §6.10): name/id, stream/consumer counts,
 * memory/store and their reserved bytes, and the account's stream-name chips
 * (the Go side caps the array at 50 names — maxStreamNames). The report is a
 * jsz broadcast aggregate, so it is manual-refresh only (no polling). A
 * failed collection (no $SYS permissions / no JS) is a degraded face: a
 * reason card with the server原文 instead of an empty list (§8.3.1).
 */
export function AccountsPanel() {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // Mid-flight guard (useConsumers 同款).
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!connected) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const res = await ListAccounts();
      if (seq.current !== my) return;
      // Degraded face: error_code (not_connected) OR the §8.3.1 partial
      // failure (empty error_code + error 原文 + empty list).
      if (res?.error_code || res?.error) {
        setErr(res.error || res.error_code);
        setAccounts([]);
      } else {
        setErr("");
        setAccounts(res?.accounts ?? []);
      }
    } catch (e) {
      if (seq.current !== my) return;
      // Transport throw (M6 Task 8 ㉒): keep the current cards + toast — a
      // transport blip must not blank a panel the user is reading (same
      // contract as the ConnectionsTop/NodeDetail failure faces).
      toast.error(t("monitor.accounts.loadFailed", { error: errText(e) }));
    } finally {
      if (seq.current === my) setLoading(false);
    }
  }, [connected, t]);

  // On connect + manual refresh only — never a timer.
  useEffect(() => {
    if (!connected) {
      setAccounts([]);
      setErr("");
      return;
    }
    void load();
  }, [connected, load]);

  const stat = (label: string, value: string) => (
    <p className="min-w-0 truncate font-mono text-xs tabular-nums">
      <span className="font-sans text-[var(--fg-muted)]">{label}</span> {value}
    </p>
  );

  return (
    <div data-testid="accounts-panel" className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2">
        <p className="text-xs text-[var(--fg-muted)]">
          {t("monitor.accounts.count", { count: num(accounts.length) })}
        </p>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          data-testid="accounts-refresh"
          aria-label={t("monitor.accounts.refresh")}
          title={t("monitor.accounts.refresh")}
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

      {err ? (
        // Degraded face: the reason原文, never a bare empty list (§8.3.1).
        <div
          data-testid="accounts-degraded"
          className="m-1 mt-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm"
        >
          <p className="font-medium text-[var(--warn-fg)]">{t("monitor.accounts.degradedTitle")}</p>
          <p className="mt-1 break-all text-xs text-[var(--fg-muted)]">{err}</p>
        </div>
      ) : accounts.length === 0 ? (
        <p data-testid="accounts-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("monitor.accounts.empty")}
        </p>
      ) : (
        <div className="mt-1 min-h-0 flex-1 overflow-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2 pb-1">
            {accounts.map((a) => (
              <div
                key={a.id || a.name}
                data-testid={`account-card-${a.name}`}
                className="min-w-0 rounded-md border border-border px-3 py-2"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <p className="truncate text-sm font-medium">{a.name || "—"}</p>
                  <p
                    className="truncate font-mono text-[10px] text-[var(--fg-faint)]"
                    title={a.id}
                  >
                    {a.id || "—"}
                  </p>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {stat(t("monitor.accounts.streams"), num(a.streams))}
                  {stat(t("monitor.accounts.consumers"), num(a.consumers))}
                  {stat(t("monitor.accounts.memory"), formatBytes(a.memory_bytes))}
                  {stat(t("monitor.accounts.store"), formatBytes(a.store_bytes))}
                  {stat(t("monitor.accounts.reservedMemory"), formatBytes(a.reserved_memory_bytes))}
                  {stat(t("monitor.accounts.reservedStore"), formatBytes(a.reserved_store_bytes))}
                </div>
                {(a.stream_names ?? []).length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(a.stream_names ?? []).map((s) => (
                      <span
                        key={s}
                        title={s}
                        className="max-w-full truncate rounded bg-[var(--border-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-muted)]"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
