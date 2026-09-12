import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import type { StreamSummary } from "../../lib/bindings";
import { useStreams } from "./useStreams";
import { StreamList } from "./StreamList";
import { StreamDetail } from "./StreamDetail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Client-side filter (spec §6.6: immediate within 500 streams): substring
 * match on the stream name or any of its subjects, case-insensitive. */
export function matchStreams(streams: StreamSummary[], query: string): StreamSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return streams;
  return streams.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.subjects.some((sub) => sub.toLowerCase().includes(q)),
  );
}

const KNOWN_REASONS = ["no_responders", "timeout", "server"] as const;

export interface StreamsPageProps {
  // Button slots (Task 10/11/13 inject the create/restore flows).
  onCreate?: () => void;
  onRestore?: () => void;
}

/**
 * Streams page (spec §6.6 / §18.1): left list rail (search filter, refresh,
 * Create/Restore slots, virtualized table) and the right detail pane with an
 * empty-state guidance. When the backend reports the stream list unavailable
 * (unavailable_reason, spec §6.6 Global Constraint) a guidance panel with the
 * domain / api_prefix troubleshooting steps replaces the table — never an
 * empty grid. Disconnected shows a connect banner instead.
 */
export function StreamsPage({ onCreate, onRestore }: StreamsPageProps) {
  const { t } = useTranslation();
  const conn = useConnState();
  const api = useStreams();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => matchStreams(api.list, query), [api.list, query]);
  const connected = conn.state === "connected";
  const unavailable = api.unavailableReason !== "";
  const reasonKey = (KNOWN_REASONS as readonly string[]).includes(api.unavailableReason)
    ? `streams.unavailable.${api.unavailableReason}`
    : "streams.unavailable.generic";

  return (
    <div data-testid="streams-page" className="flex min-h-0 flex-1">
      {/* Left rail: search + refresh + slots + list */}
      <aside className="flex w-[440px] min-w-[340px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <Input
            data-testid="streams-search"
            aria-label={t("streams.search")}
            placeholder={t("streams.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8"
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="streams-refresh"
            aria-label={t("streams.refresh")}
            onClick={api.refresh}
            disabled={!connected || api.loading}
            className="h-8 shrink-0 px-2"
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          {onCreate && (
            <Button size="sm" data-testid="streams-create" onClick={onCreate} className="h-8 shrink-0">
              {t("streams.create")}
            </Button>
          )}
          {onRestore && (
            <Button
              size="sm"
              variant="outline"
              data-testid="streams-restore"
              onClick={onRestore}
              className="h-8 shrink-0"
            >
              {t("streams.restore")}
            </Button>
          )}
        </div>

        {!connected ? (
          <div
            data-testid="streams-not-connected"
            className="mx-3 mb-3 rounded-md border border-border bg-panel p-3 text-sm text-[var(--fg-muted)]"
          >
            {t("streams.notConnected")}
          </div>
        ) : unavailable ? (
          <div
            data-testid="streams-unavailable"
            className="mx-3 mb-3 flex flex-col gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm"
          >
            <p className="font-medium">{t("streams.unavailable.title")}</p>
            <p className="text-[var(--fg-muted)]">{t(reasonKey)}</p>
            <ul className="ml-4 list-disc text-xs text-[var(--fg-muted)]">
              <li>{t("streams.unavailable.checkDomain")}</li>
              <li>{t("streams.unavailable.checkPrefix")}</li>
            </ul>
          </div>
        ) : (
          <StreamList
            streams={filtered}
            rates={api.rates}
            selected={api.selected}
            onSelect={api.select}
          />
        )}
      </aside>

      {/* Right pane: detail or empty-state guidance */}
      <section className="flex min-w-0 flex-1 flex-col">
        {api.detail ? (
          <StreamDetail
            detail={api.detail}
            loading={api.detailLoading}
            rate={api.rate}
            series={api.series}
          />
        ) : (
          <div
            data-testid="streams-detail-empty"
            className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
          >
            <p className="text-sm font-medium">{t("streams.detail.emptyTitle")}</p>
            <p className="max-w-sm text-xs text-[var(--fg-muted)]">
              {t("streams.detail.emptyBody")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

export default StreamsPage;
