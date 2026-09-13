import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "../../app/i18n";
import { bytesToHex, fromBase64, fromBase64Bytes } from "../../lib/base64";
import { formatBytes } from "../messages/schema";
import type { KvWatchApi, KvWatchEvent } from "./useKv";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Fixed-equal rows (28px, overscan 8) so a 10k-event ring costs O(viewport),
// mirroring the sessions message list.
const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const PREVIEW_CHARS = 32;
const HEX_PREVIEW_CHARS = 24;

/** Row preview content: UTF-8 text, or hex with the binary marker, capped so
 * one giant value cannot flood the 28px row. */
function rowPreview(ev: KvWatchEvent): { binary: boolean; text: string } {
  if (!ev.is_utf8) {
    const hex = bytesToHex(fromBase64Bytes(ev.payload_b64));
    return {
      binary: true,
      text: hex.length > HEX_PREVIEW_CHARS ? `${hex.slice(0, HEX_PREVIEW_CHARS)}…` : hex,
    };
  }
  const text = fromBase64(ev.payload_b64);
  return {
    binary: false,
    text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
  };
}

/** ms epoch → local time-of-day for the narrow list row. */
function timeOnly(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleTimeString() : "";
}

/**
 * KV watch panel (spec §6.8 / §6.4): Start with an optional key filter (empty
 * = whole-bucket watch — the backend routes "" to WatchAll before
 * ValidateWatchFilter ever runs), then the live virtualized event rows (time
 * / operation badge / key / revision / value preview), the key="" sentinel
 * row marking the end of the initial snapshot, the cumulative dropped chip
 * fed by the latest event's dropped_total (warning color when > 0), and Stop.
 * The ring holds at most the newest 10k events (useKv's applyWatchEvent).
 */
export function WatchPanel({ bucket, watch }: { bucket: string; watch: KvWatchApi }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: watch.events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  return (
    <section data-testid="kv-watch" className="flex min-h-0 flex-col rounded-md border border-border">
      {/* Toolbar: filter input + Start/Stop + dropped chip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">{t("kv.watch.title")}</h3>
        <Input
          data-testid="kv-watch-filter"
          aria-label={t("kv.watch.filter")}
          placeholder={t("kv.watch.filterHint")}
          value={filter}
          disabled={watch.active !== null}
          onChange={(e) => setFilter(e.target.value)}
          className="ml-2 h-8 max-w-56 font-mono"
        />
        {watch.active === null ? (
          <Button
            size="sm"
            data-testid="kv-watch-start"
            className="ml-auto h-8"
            disabled={!bucket}
            onClick={() => {
              // Empty filter = watch the whole bucket (CreateKvWatch routes
              // "" to WatchAll; ValidateWatchFilter only sees non-empty
              // filters).
              void watch.start(bucket, filter.trim());
            }}
          >
            {t("kv.watch.start")}
          </Button>
        ) : (
          <>
            <Badge
              variant="outline"
              data-testid="kv-watch-dropped"
              className={
                watch.dropped > 0
                  ? "ml-auto border-[var(--warn)] text-[var(--warn)]"
                  : "ml-auto text-[var(--fg-muted)]"
              }
            >
              {t("kv.watch.dropped", { n: watch.dropped })}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              data-testid="kv-watch-stop"
              className="h-8"
              onClick={watch.stop}
            >
              {t("kv.watch.stop")}
            </Button>
          </>
        )}
      </div>

      {watch.active === null ? (
        <p className="p-4 text-sm text-[var(--fg-muted)]">{t("kv.watch.inactive")}</p>
      ) : (
        <div
          ref={parentRef}
          data-testid="kv-watch-list"
          className="h-56 overflow-auto rounded-b-md"
        >
          <div
            className="relative w-full font-mono text-xs"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const ev = watch.events[vi.index];
              if (!ev) return null;
              // Sentinel (key "" — the initial snapshot is complete).
              if (ev.key === "") {
                return (
                  <div
                    key={vi.key}
                    data-testid="kv-watch-sentinel"
                    className="absolute left-0 flex w-full items-center gap-3 border-b border-[var(--border-soft)] px-3 text-[var(--fg-muted)]"
                    style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
                  >
                    <span aria-hidden="true">✓</span>
                    <span>{t("kv.watch.sentinel")}</span>
                  </div>
                );
              }
              const preview = rowPreview(ev);
              return (
                <div
                  key={vi.key}
                  data-testid="kv-watch-row"
                  className="absolute left-0 flex w-full items-center gap-3 border-b border-[var(--border-soft)] px-3"
                  style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="w-20 shrink-0 text-[var(--fg-faint)]">
                    {timeOnly(ev.timestamp_ms)}
                  </span>
                  <Badge
                    variant={
                      ev.operation === "delete" || ev.operation === "purge"
                        ? "destructive"
                        : "outline"
                    }
                    className="shrink-0 px-1.5 py-0 text-[10px]"
                  >
                    {ev.operation}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate" title={ev.key}>
                    {ev.key}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-[var(--fg-faint)]">
                    #{ev.revision}
                  </span>
                  <span
                    className={`w-44 shrink-0 truncate text-right ${
                      preview.binary ? "text-[var(--fg-muted)]" : ""
                    }`}
                    title={formatBytes(ev.payload_size)}
                  >
                    {preview.text}
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
