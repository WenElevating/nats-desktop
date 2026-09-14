import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Eraser } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { CreateSysWatch, StopSysWatch } from "../../lib/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// $SYS event stream panel (spec §8.3 / Task 12). One frontend watch at a time:
// type chips + a debounced subject regex rebuild the Go-side watch
// (StopSysWatch(old) → CreateSysWatch(new)); events arrive as plain JSON on
// the "sys:event" emit (payload is emit-side only and NOT part of the
// generated bindings — SysWatchEvent below mirrors internal/monitor/types.go).
// The frontend keeps a 10,000-entry newest-first ring and renders it
// virtualized; dropped_total/filtered_total are emit-side counters passed
// through on every payload.
// ---------------------------------------------------------------------------

/** Closed event-type set (Global 10; Go forms.go EventSubjects whitelist). */
export const EVENT_TYPES = [
  "account_connect",
  "account_disconnect",
  "auth_error",
  "js_advisory",
  "js_metric",
] as const;

export type SysEventType = (typeof EVENT_TYPES)[number];

/** Frontend ring capacity (brief: 10,000 entries, newest first). */
export const EVENT_RING_CAPACITY = 10_000;

/** Regex input debounce (brief: 400ms). */
export const REGEX_DEBOUNCE_MS = 400;

/** Watch-failure toast rate limit (M6 Task 8 ㉖): the same error key toasts at
 * most once per window — every filter chip flip rebuilds the watch, so a
 * persistently failing create would otherwise spam one toast per flip. */
export const WATCH_TOAST_RATE_LIMIT_MS = 5000;

/**
 * Pure rate-limit decision for watch-failure toasts: `key` (the raw error
 * 原文) may toast again only after `windowMs` since its last toast. Records
 * `now` when returning true. Bounded: past 50 distinct keys the table resets
 * (an error flood is itself pathological).
 */
export function shouldToastError(
  last: Map<string, number>,
  key: string,
  now: number,
  windowMs = WATCH_TOAST_RATE_LIMIT_MS,
): boolean {
  const at = last.get(key);
  if (at !== undefined && now - at < windowMs) return false;
  if (last.size > 50) last.clear();
  last.set(key, now);
  return true;
}

const ROW_HEIGHT = 26;
const OVERSCAN = 8;

/** SysEvent — mirror of Go internal/monitor/types.go SysEvent (wire shape). */
export interface SysEvent {
  seq: number;
  subject: string;
  type: string;
  occurred_ms: number;
  server_name: string;
  server_cluster: string;
  account: string;
  summary: string;
  size_bytes: number;
}

/** SysWatchEvent — mirror of Go SysWatchEvent; emit-side only. */
export interface SysWatchEvent {
  watch_id: string;
  event: SysEvent;
  dropped_total: number;
  filtered_total: number;
}

/**
 * Pure ring helper: prepend and cap at `cap` entries (newest first). Exported
 * so tests can drive truncation directly without firing 10k DOM events.
 */
export function pushEvent<T>(ring: T[], e: T, cap = EVENT_RING_CAPACITY): T[] {
  const next = ring.length >= cap ? [e, ...ring.slice(0, cap - 1)] : [e, ...ring];
  return next;
}

/** Wire-tolerant coercion of one sys:event payload; null = dropped. */
export function toSysWatchEvent(raw: unknown): SysWatchEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SysWatchEvent>;
  if (typeof r.watch_id !== "string") return null;
  const e = (r.event ?? {}) as Partial<SysEvent>;
  const numOf = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const strOf = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    watch_id: r.watch_id,
    dropped_total: numOf(r.dropped_total),
    filtered_total: numOf(r.filtered_total),
    event: {
      seq: numOf(e.seq),
      subject: strOf(e.subject),
      type: strOf(e.type),
      occurred_ms: numOf(e.occurred_ms),
      server_name: strOf(e.server_name),
      server_cluster: strOf(e.server_cluster),
      account: strOf(e.account),
      summary: strOf(e.summary),
      size_bytes: numOf(e.size_bytes),
    },
  };
}

/** ms epoch → local HH:mm:ss.SSS (event-row time cell). */
export function formatEventTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Toast a failed watch create through the ㉖ rate limit (keyed on the raw
 * error 原文 — stable across languages, unlike the localized template).
 */
function watchCreateFailed(
  t: (key: string, opts: { error: string }) => string,
  last: Map<string, number>,
  rawError: string,
): void {
  if (!shouldToastError(last, rawError, Date.now())) return;
  toast.error(t("monitor.events.watchError", { error: rawError }));
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Events tab (spec §8.3): type chips (closed five-type set) + regex filter +
 * the virtualized newest-first event stream with a total/dropped/filtered
 * status bar and a clear button. Watch lifecycle: create on mount with all
 * five types and no regex; a type or (valid, debounced) regex change stops the
 * old watch before creating the new one; unmount/disconnect stop it. An
 * invalid regex shows inline red text and leaves the running watch untouched.
 */
export function EventsPanel() {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [types, setTypes] = useState<ReadonlySet<SysEventType>>(new Set(EVENT_TYPES));
  const [regexInput, setRegexInput] = useState("");
  const [regex, setRegex] = useState("");
  const [regexError, setRegexError] = useState("");

  const [events, setEvents] = useState<SysEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [filtered, setFiltered] = useState(0);

  const watchRef = useRef<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  // Last-toasted timestamps per raw error (the ㉖ rate limit below).
  const watchToastAt = useRef(new Map<string, number>());

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  // Regex input → debounced valid regex (400ms). An invalid pattern flags the
  // inline error and deliberately does NOT touch the regex state, so the
  // watch below is never rebuilt for garbage input.
  useEffect(() => {
    const timer = setTimeout(() => {
      const v = regexInput.trim();
      if (v === "") {
        setRegexError("");
        setRegex("");
        return;
      }
      try {
        new RegExp(v);
        setRegexError("");
        setRegex(v);
      } catch {
        setRegexError(v);
      }
    }, REGEX_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [regexInput]);

  const typesKey = useMemo(
    () => EVENT_TYPES.filter((ty) => types.has(ty)).join(","),
    [types],
  );

  // Watch lifecycle: one watch at a time; a dependency change stops the
  // previous watch (cleanup) before creating the next one.
  useEffect(() => {
    const stop = () => {
      const id = watchRef.current;
      watchRef.current = null;
      if (id) StopSysWatch(id).catch(() => {});
    };
    if (!connected || typesKey === "") {
      stop();
      return;
    }
    stop();
    let cancelled = false;
    void (async () => {
      try {
        const res = await CreateSysWatch({ types: typesKey.split(","), regex });
        if (cancelled) {
          // The filter moved on (or the panel unmounted) mid-flight: release
          // the freshly created watch so it cannot leak.
          if (res?.watch_id) StopSysWatch(res.watch_id).catch(() => {});
          return;
        }
        if (res?.error_code) {
          watchCreateFailed(t, watchToastAt.current, res.error || res.error_code);
          return;
        }
        watchRef.current = res?.watch_id ?? null;
      } catch (err) {
        /* transport-level: the next filter/connection change re-syncs */
        watchCreateFailed(t, watchToastAt.current, errText(err));
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
    // t included: error toasts re-localize on language switch, which re-syncs
    // the watch via the panel's own Stop→Create pattern (rare, harmless).
  }, [connected, typesKey, regex, t]);

  // The sys:event subscription lives for the panel's lifetime; payloads for
  // other/old watch ids are ignored by id so a stale delivery cannot land.
  useEffect(() => {
    const off = Events.On("sys:event", (e: { data?: unknown }) => {
      const ev = toSysWatchEvent(e?.data);
      if (!ev || ev.watch_id !== watchRef.current) return;
      setEvents((prev) => pushEvent(prev, ev.event));
      setTotal((n) => n + 1);
      setDropped(ev.dropped_total);
      setFiltered(ev.filtered_total);
    });
    return () => {
      off();
    };
  }, []);

  const toggleType = useCallback((ty: SysEventType) => {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(ty)) next.delete(ty);
      else next.add(ty);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
    setTotal(0);
  }, []);

  return (
    <div data-testid="events-panel" className="flex min-h-0 flex-1 flex-col">
      {/* Filter row: type chips + regex + status + clear */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {EVENT_TYPES.map((ty) => {
          const on = types.has(ty);
          return (
            <button
              key={ty}
              type="button"
              data-testid={`sys-event-type-${ty}`}
              aria-pressed={on}
              onClick={() => toggleType(ty)}
              title={ty}
              className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                on
                  ? "border-transparent bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                  : "border-border text-[var(--fg-muted)] hover:text-foreground"
              }`}
            >
              {ty}
            </button>
          );
        })}
        <Input
          data-testid="sys-event-regex"
          aria-label={t("monitor.events.regex")}
          placeholder={t("monitor.events.regex")}
          value={regexInput}
          disabled={!connected}
          onChange={(e) => setRegexInput(e.target.value)}
          className="h-7 w-52 font-mono text-xs"
        />
        <div className="flex-1" />
        <span data-testid="sys-event-total" className="text-xs tabular-nums text-[var(--fg-muted)]">
          {t("monitor.events.total")} {total.toLocaleString("en-US")}
        </span>
        <Badge
          data-testid="sys-event-dropped"
          className={
            dropped > 0
              ? "bg-[var(--danger-soft)] px-1.5 py-0 text-[10px] text-[var(--danger-fg)]"
              : "px-1.5 py-0 text-[10px]"
          }
          variant={dropped > 0 ? "destructive" : "outline"}
          title={t("monitor.events.dropped")}
        >
          {t("monitor.events.dropped")} {dropped.toLocaleString("en-US")}
        </Badge>
        <span data-testid="sys-event-filtered" className="text-xs tabular-nums text-[var(--fg-muted)]">
          {t("monitor.events.filtered")} {filtered.toLocaleString("en-US")}
        </span>
        <Button
          size="sm"
          variant="outline"
          data-testid="sys-event-clear"
          aria-label={t("monitor.events.clear")}
          title={t("monitor.events.clear")}
          onClick={clear}
          disabled={events.length === 0}
          className="h-7 shrink-0 px-2"
        >
          <Eraser size={13} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>

      {/* Inline regex validation: red原文, watch untouched (brief). */}
      {regexError !== "" && (
        <p
          data-testid="sys-event-regex-error"
          className="mt-1 shrink-0 break-all text-xs text-[var(--danger-fg)]"
        >
          {t("monitor.events.regexInvalid")}: {regexError}
        </p>
      )}
      {typesKey === "" && (
        <p className="mt-1 shrink-0 text-xs text-[var(--warn-fg)]">
          {t("monitor.events.needType")}
        </p>
      )}

      {/* Virtualized newest-first stream */}
      {events.length === 0 ? (
        <p data-testid="sys-event-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t(connected ? "monitor.events.empty" : "monitor.events.notConnected")}
        </p>
      ) : (
        <div
          ref={parentRef}
          data-testid="sys-event-list"
          className="mt-1 min-h-0 flex-1 overflow-auto font-mono text-xs"
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const ev = events[vi.index];
              if (!ev) return null;
              return (
                <div
                  key={vi.key}
                  data-testid={`sys-event-row-${ev.seq}`}
                  className="absolute left-0 grid w-full grid-cols-[92px_128px_minmax(0,1fr)_180px_64px] items-center gap-2 whitespace-nowrap px-1 text-xs hover:bg-[var(--accent-soft)]"
                  style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
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
                    {ev.server_name && (
                      <Badge
                        variant="outline"
                        className="max-w-full overflow-hidden px-1.5 py-0 text-[10px]"
                        title={ev.server_cluster ? `${ev.server_cluster}/${ev.server_name}` : ev.server_name}
                      >
                        <span className="truncate">{ev.server_name}</span>
                      </Badge>
                    )}
                  </span>
                  <span className="min-w-0 truncate" title={ev.summary}>
                    <span className="font-sans text-[var(--fg-muted)]">
                      {ev.account ? `${ev.account} · ` : ""}
                    </span>
                    {ev.summary}
                  </span>
                  <span className="min-w-0 truncate text-[var(--fg-muted)]" title={ev.subject}>
                    {ev.subject}
                  </span>
                  <span className="text-right tabular-nums text-[var(--fg-muted)]">
                    {ev.size_bytes.toLocaleString("en-US")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default EventsPanel;
