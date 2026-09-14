import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "../../app/i18n";
import { formatBytes } from "../../lib/format";
import type { ObjWatchApi } from "./useObjects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Fixed-equal rows (28px, overscan 8) so a 10k-event ring costs O(viewport),
// mirroring the kv watch panel.
const ROW_HEIGHT = 28;
const OVERSCAN = 8;

/** ms epoch → local time-of-day for the narrow list row. */
function timeOnly(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleTimeString() : "";
}

/**
 * Object watch panel (spec §6.9): Start watches the whole bucket (CreateObjWatch
 * takes no filter), then the live virtualized event rows (time / deleted badge
 * / name / size / chunks), the name="" sentinel row marking the end of the
 * initial snapshot, the cumulative dropped chip fed by the latest event's
 * dropped_total (warning color when > 0), and Stop. The ring holds at most the
 * newest 10k events (useObjects' applyWatchEvent).
 */
export function ObjectWatchPanel({ bucket, watch }: { bucket: string; watch: ObjWatchApi }) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: watch.events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  return (
    <section data-testid="objects-watch" className="flex min-h-0 flex-col rounded-md border border-border">
      {/* Toolbar: Start/Stop + dropped chip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">{t("objects.watch.title")}</h3>
        {watch.active === null ? (
          <Button
            size="sm"
            data-testid="objects-watch-start"
            className="ml-auto h-8"
            disabled={!bucket}
            onClick={() => {
              void watch.start(bucket);
            }}
          >
            {t("objects.watch.start")}
          </Button>
        ) : (
          <>
            <Badge
              variant="outline"
              data-testid="objects-watch-dropped"
              className={
                watch.dropped > 0
                  ? "ml-auto border-[var(--warn)] text-[var(--warn)]"
                  : "ml-auto text-[var(--fg-muted)]"
              }
            >
              {t("objects.watch.dropped", { n: watch.dropped })}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              data-testid="objects-watch-stop"
              className="h-8"
              onClick={watch.stop}
            >
              {t("objects.watch.stop")}
            </Button>
          </>
        )}
      </div>

      {watch.active === null ? (
        <p className="p-4 text-sm text-[var(--fg-muted)]">{t("objects.watch.inactive")}</p>
      ) : (
        <div
          ref={parentRef}
          data-testid="objects-watch-list"
          className="h-56 overflow-auto rounded-b-md"
        >
          <div
            className="relative w-full font-mono text-xs"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const ev = watch.events[vi.index];
              if (!ev) return null;
              // Sentinel (name "" — the initial snapshot is complete).
              if (ev.name === "") {
                return (
                  <div
                    key={vi.key}
                    data-testid="objects-watch-sentinel"
                    className="absolute left-0 flex w-full items-center gap-3 border-b border-[var(--border-soft)] px-3 text-[var(--fg-muted)]"
                    style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
                  >
                    <span aria-hidden="true">✓</span>
                    <span>{t("objects.watch.sentinel")}</span>
                  </div>
                );
              }
              return (
                <div
                  key={vi.key}
                  data-testid="objects-watch-row"
                  className="absolute left-0 flex w-full items-center gap-3 border-b border-[var(--border-soft)] px-3"
                  style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="w-20 shrink-0 text-[var(--fg-faint)]">
                    {timeOnly(ev.mod_time_ms)}
                  </span>
                  {ev.deleted && (
                    <Badge variant="destructive" className="shrink-0 px-1.5 py-0 text-[10px]">
                      {t("objects.list.deleted")}
                    </Badge>
                  )}
                  <span className="min-w-0 flex-1 truncate" title={ev.name}>
                    {ev.name}
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums">
                    {formatBytes(ev.size)}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-[var(--fg-faint)]">
                    {ev.chunks}c
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export default ObjectWatchPanel;
