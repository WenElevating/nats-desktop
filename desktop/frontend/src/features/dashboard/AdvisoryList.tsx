import { useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { ShieldOff } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { CreateSysWatch, StopSysWatch } from "../../lib/bindings";
import { Badge } from "@/components/ui/badge";
import {
  formatEventTime,
  pushEvent,
  toSysWatchEvent,
  type SysEvent,
} from "../monitoring/EventsPanel";

// ---------------------------------------------------------------------------
// Dashboard advisory list (spec §6.5). One $SYS watch for the page's lifetime:
// created on mount with the four advisory types (the js_metric telemetry type
// is deliberately excluded — the dashboard shows occurrences, not meters),
// stopped on unmount. Events arrive as plain JSON on the "sys:event" emit;
// the payload typing mirrors internal/monitor/types.go SysWatchEvent — the
// wire types and coercion are shared with the monitoring EventsPanel (single
// source of truth, no second definition).
//
// The frontend keeps a 100-entry newest-first ring (§6.5: 最多保留 100 条，
// 新事件置顶) — far smaller than EventsPanel's 10k ring, so the list renders
// as a plain overflow-auto list with no virtualizer.
// ---------------------------------------------------------------------------

/** Closed advisory-type set for the dashboard watch (§6.5; Global 10). */
export const ADVISORY_TYPES = [
  "account_connect",
  "account_disconnect",
  "auth_error",
  "js_advisory",
] as const;

/** Frontend ring capacity (§6.5: at most 100 entries, newest first). */
export const ADVISORY_RING_CAPACITY = 100;

/**
 * Pure ring helper: prepend and cap at `cap` entries (newest first). M6 Task
 * 8 ㉛: the body is delegated to EventsPanel.pushEvent — one ring primitive,
 * the advisory ring just carries its own 100-entry default cap.
 */
export function pushAdvisory<T>(ring: T[], e: T, cap = ADVISORY_RING_CAPACITY): T[] {
  return pushEvent(ring, e, cap);
}

export interface AdvisoryListProps {
  /** No $SYS permission (§6.5 失败面): the list is replaced by the same
   * explanation card as the metric cards, and no watch is created. */
  degraded: boolean;
}

/**
 * Recent-advisory list for the Dashboard (spec §6.5). Watch lifecycle mirrors
 * EventsPanel: create on mount (connected, not degraded), stop on unmount or
 * disconnect; payloads for other/old watch ids are ignored by id so a stale
 * delivery cannot land. Row = time / type badge / source server / summary
 * (subject fallback when the payload carries no summary).
 */
export function AdvisoryList({ degraded }: AdvisoryListProps) {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [events, setEvents] = useState<SysEvent[]>([]);
  const watchRef = useRef<string | null>(null);

  // Watch lifecycle: created once per (connected && !degraded) spell; cleanup
  // stops the previous watch before any re-create and on unmount.
  useEffect(() => {
    const stop = () => {
      const id = watchRef.current;
      watchRef.current = null;
      if (id) StopSysWatch(id).catch(() => {});
    };
    if (!connected || degraded) {
      stop();
      return;
    }
    stop();
    let cancelled = false;
    void (async () => {
      try {
        const res = await CreateSysWatch({ types: [...ADVISORY_TYPES], regex: "" });
        if (cancelled) {
          // Unmounted (or degraded mid-flight): release the fresh watch so it
          // cannot leak.
          if (res?.watch_id) StopSysWatch(res.watch_id).catch(() => {});
          return;
        }
        if (res?.error_code) {
          toast.error(t("monitor.events.watchError", { error: res.error || res.error_code }));
          return;
        }
        watchRef.current = res?.watch_id ?? null;
      } catch (err) {
        /* transport-level: the next connection/degradation change re-syncs */
        toast.error(
          t("monitor.events.watchError", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
    // t included: error toasts re-localize on language switch, which re-syncs
    // the watch via the panel's own Stop→Create pattern (rare, harmless).
  }, [connected, degraded, t]);

  // The sys:event subscription lives for the component's lifetime.
  useEffect(() => {
    const off = Events.On("sys:event", (e: { data?: unknown }) => {
      const ev = toSysWatchEvent(e?.data);
      if (!ev || ev.watch_id !== watchRef.current) return;
      setEvents((prev) => pushAdvisory(prev, ev.event));
    });
    return () => {
      off();
    };
  }, []);

  // §6.5 失败面: no $SYS permission → the same explanation card as the card
  // group (其余功能不受影响); the watch is deliberately not created.
  if (degraded) {
    return (
      <div
        data-testid="advisory-degraded"
        className="flex min-h-0 flex-1 flex-col items-start justify-center gap-1 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-4 text-sm"
      >
        <p className="flex items-center gap-2 font-medium text-[var(--warn-fg)]">
          <ShieldOff size={14} strokeWidth={1.75} aria-hidden="true" />
          {t("dashboard.noPermission")}
        </p>
        <p className="text-xs text-[var(--fg-muted)]">{t("dashboard.noPermissionBody")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {events.length === 0 ? (
        <p data-testid="advisory-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t(connected ? "dashboard.advisory.empty" : "dashboard.advisory.notConnected")}
        </p>
      ) : (
        <div
          data-testid="advisory-list"
          className="min-h-0 flex-1 overflow-auto font-mono text-xs"
        >
          {events.map((ev) => (
            <div
              key={ev.seq}
              data-testid={`advisory-row-${ev.seq}`}
              className="grid grid-cols-[92px_150px_110px_minmax(0,1fr)] items-center gap-2 whitespace-nowrap border-b border-border px-1 py-1 hover:bg-[var(--accent-soft)]"
            >
              <span className="tabular-nums text-[var(--fg-muted)]" title={String(ev.seq)}>
                {formatEventTime(ev.occurred_ms)}
              </span>
              <span className="flex min-w-0 items-center gap-1">
                <Badge
                  variant="secondary"
                  className="max-w-full justify-start overflow-hidden px-1.5 py-0 font-mono text-[10px]"
                  title={ev.type || ev.subject}
                >
                  <span className="truncate">{ev.type || t("monitor.events.noType")}</span>
                </Badge>
              </span>
              <span className="min-w-0 truncate text-[var(--fg-muted)]" title={ev.server_name}>
                {ev.server_name}
              </span>
              <span className="min-w-0 truncate" title={ev.summary || ev.subject}>
                {ev.summary || ev.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AdvisoryList;
