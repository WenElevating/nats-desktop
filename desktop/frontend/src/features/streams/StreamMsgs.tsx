import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import {
  BrowseStream,
  GetStreamMessage,
  RemoveStreamMessage,
  type BrowserMsg,
} from "../../lib/bindings";
import { formatBytes } from "../../lib/format";
import { PayloadView } from "../../lib/payload";
import { useConfirm } from "../../lib/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Closed page-size set (spec §6.6) — the Go side rejects anything else. */
export const PAGE_SIZES = [20, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;

/** Binary payloads preview as the hex of their first 4 KiB (AC-029). */
const HEX_PREVIEW_BYTES = 4096;

export interface StreamMsgsSummary {
  firstSeq: number;
  lastSeq: number;
  /**
   * Host stream retention ("limits" | "interest" | "workqueue"). Older
   * callers may omit it — only used for the workqueue browse hint.
   */
  retention?: string;
}

/**
 * Browse-failure toast text: workqueue streams get an extra allow_direct
 * hint appended (natscli parity — the server rejects browsing unless
 * allow_direct is enabled; pure, exported for tests).
 */
export function withWorkqueueHint(base: string, retention: string | undefined, hint: string): string {
  return retention === "workqueue" ? `${base} ${hint}` : base;
}

export interface StreamMsgsProps {
  stream: string;
  /** Stream state bounds for the first/last page buttons (GetStreamDetail). */
  summary: StreamMsgsSummary | null;
  onClose: () => void;
}

/**
 * Previous page start (pure, exported for tests): a full page back from the
 * page's first row, clamped to the stream's first sequence so a purged
 * stream can never page below its data.
 */
export function computePrevStart(
  msgs: BrowserMsg[],
  pageSize: number,
  firstSeq: number,
): number {
  if (msgs.length === 0) return firstSeq;
  return Math.max(firstSeq, msgs[0].seq - pageSize);
}

/**
 * Missing sequence numbers between the page's first and last row (pure,
 * exported for tests). After a single-message delete + refresh the removed
 * seq shows up here and renders as a「已删除 seq」marker row (AC-009).
 */
export function detectHoles(msgs: BrowserMsg[]): number[] {
  const holes: number[] = [];
  for (let i = 1; i < msgs.length; i++) {
    for (let s = msgs[i - 1].seq + 1; s < msgs[i].seq; s++) holes.push(s);
  }
  return holes;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** ms epoch → local date-time; 0 → "—" (never a bogus 1970 date). */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "—";
}

type Row =
  | { kind: "msg"; key: string; msg: BrowserMsg }
  | { kind: "hole"; key: string; seq: number };

/** Column template shared by the header row and the data rows. */
const GRID_COLS = "grid-cols-[64px_minmax(0,1fr)_72px_150px_96px]";

/**
 * Stream message browser (spec §6.6 / AC-029): a self-contained paging state
 * machine — the request fully describes the page (stream/start_seq/count/
 * subject_filter), so every control just computes the next start_seq:
 * next = response's next_start_seq, prev = computePrevStart, last =
 * max(firstSeq, lastSeq - pageSize + 1). Under a subject filter paging is
 * forward-only (the server-side filtered delivery cannot be reversed), so
 * prev is disabled. Row click opens the right-side detail; truncated rows
 * (>1MB, 64KB page preview) fetch their full payload via GetStreamMessage.
 */
export function StreamMsgs({ stream, summary, onClose }: StreamMsgsProps) {
  const { t } = useTranslation();
  const { confirmL1 } = useConfirm();
  const firstSeq = summary?.firstSeq ?? 1;

  const [pageStart, setPageStart] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [filterDraft, setFilterDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [jumpDraft, setJumpDraft] = useState("");

  const [msgs, setMsgs] = useState<BrowserMsg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextStart, setNextStart] = useState(1);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<BrowserMsg | null>(null);
  const [fullMsg, setFullMsg] = useState<BrowserMsg | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(
    async (start: number, count: number, subject: string) => {
      setLoading(true);
      try {
        const res = await BrowseStream({ stream, start_seq: start, count, subject_filter: subject });
        if (res?.error_code) {
          toast.error(
            withWorkqueueHint(
              t("streams.msgs.loadFailed", { error: res.error || res.error_code }),
              summary?.retention,
              t("streams.msgs.workqueueHint"),
            ),
          );
          return;
        }
        setMsgs(res?.messages ?? []);
        setHasMore(res?.has_more ?? false);
        setNextStart(res?.next_start_seq ?? start);
      } catch (err) {
        toast.error(
          withWorkqueueHint(
            t("streams.msgs.loadFailed", { error: errText(err) }),
            summary?.retention,
            t("streams.msgs.workqueueHint"),
          ),
        );
      } finally {
        setLoading(false);
      }
    },
    [stream, t, summary?.retention],
  );

  // The paging state IS the request: any control change re-issues BrowseStream
  // (open defaults to start_seq=1 / count=50 — brief).
  useEffect(() => {
    void load(pageStart, pageSize, filter);
  }, [load, pageStart, pageSize, filter]);

  // Stream switch (when the host does not remount): restart from the top.
  useEffect(() => {
    setPageStart(1);
    setFilterDraft("");
    setFilter("");
    setJumpDraft("");
    setSelected(null);
    setFullMsg(null);
  }, [stream]);

  // Truncated rows carry only the 64KB preview — fetch the full payload.
  useEffect(() => {
    setFullMsg(null);
    if (!selected || !selected.truncated) return;
    let alive = true;
    setDetailLoading(true);
    GetStreamMessage(stream, selected.seq)
      .then((res) => {
        if (!alive) return;
        if (res?.error_code || !res?.msg) {
          toast.error(
            t("streams.msgs.loadFailed", { error: res?.error || res?.error_code || "not found" }),
          );
          return;
        }
        setFullMsg(res.msg);
      })
      .catch((err) => {
        if (alive) toast.error(t("streams.msgs.loadFailed", { error: errText(err) }));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected, stream, t]);

  const rows = useMemo<Row[]>(() => {
    const holes = detectHoles(msgs);
    const out: Row[] = [];
    let hi = 0;
    for (const m of msgs) {
      while (hi < holes.length && holes[hi] < m.seq) {
        out.push({ kind: "hole", key: `hole-${holes[hi]}`, seq: holes[hi] });
        hi++;
      }
      out.push({ kind: "msg", key: `msg-${m.seq}`, msg: m });
    }
    return out;
  }, [msgs]);

  const applyFilter = () => {
    setFilter(filterDraft.trim());
    // A new filter restarts the forward-only scan from the stream head.
    setPageStart(firstSeq);
  };

  const applyJump = () => {
    const n = Number.parseInt(jumpDraft, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setPageStart(Math.max(1, n));
  };

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const seq = selected.seq;
    // Global Constraint 4: single-message delete is a level-1 confirm.
    const ok = await confirmL1({
      titleKey: "streams.msgs.deleteTitle",
      bodyKey: "streams.msgs.deleteBody",
      data: { seq: String(seq), stream },
    });
    if (!ok) return;
    try {
      const res = await RemoveStreamMessage(stream, seq);
      if (res?.error_code) {
        toast.error(t("streams.msgs.deleteFailed", { error: res.error || res.error_code }));
        return;
      }
      toast.success(t("streams.msgs.deletedToast", { seq }));
      setSelected(null);
      // 操作后刷新: re-fetch the current page window; the removed seq comes
      // back as a detectHoles marker row.
      await load(pageStart, pageSize, filter);
    } catch (err) {
      toast.error(t("streams.msgs.deleteFailed", { error: errText(err) }));
    }
  }, [selected, confirmL1, stream, t, load, pageStart, pageSize, filter]);

  const viewed = fullMsg ?? selected;
  const prevStart = computePrevStart(msgs, pageSize, firstSeq);
  const lastStart = Math.max(firstSeq, (summary?.lastSeq ?? 0) - pageSize + 1);

  return (
    <div data-testid="msgs-panel" className="flex min-h-0 flex-1 flex-col">
      {/* Header: stream name + paging controls + page size + subject filter */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <h2 data-testid="msgs-stream-name" className="text-sm font-semibold">
          {stream}
        </h2>
        <span className="text-xs text-[var(--fg-muted)]">{t("streams.msgs.title")}</span>
        {summary?.retention === "workqueue" && (
          <span
            data-testid="msgs-workqueue-hint"
            className="max-w-[420px] truncate text-xs text-[var(--warn)]"
            title={t("streams.msgs.workqueueHint")}
          >
            {t("streams.msgs.workqueueHint")}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="msgs-first"
            disabled={loading}
            onClick={() => setPageStart(firstSeq)}
          >
            {t("streams.msgs.first")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="msgs-prev"
            disabled={loading || filter !== "" || msgs.length === 0}
            onClick={() => setPageStart(prevStart)}
          >
            {t("streams.msgs.prev")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="msgs-next"
            disabled={loading || !hasMore}
            onClick={() => setPageStart(nextStart)}
          >
            {t("streams.msgs.next")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="msgs-last"
            disabled={loading || !summary || (summary.lastSeq ?? 0) < 1}
            onClick={() => setPageStart(lastStart)}
          >
            {t("streams.msgs.last")}
          </Button>

          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              applyJump();
            }}
          >
            <Input
              data-testid="msgs-jump"
              aria-label={t("streams.msgs.jump")}
              placeholder={t("streams.msgs.jump")}
              value={jumpDraft}
              inputMode="numeric"
              className="h-8 w-24"
              onChange={(e) => setJumpDraft(e.target.value)}
            />
            <Button size="sm" variant="outline" type="submit" data-testid="msgs-jump-go" className="h-8">
              {t("streams.msgs.jumpGo")}
            </Button>
          </form>

          <select
            data-testid="msgs-page-size"
            aria-label={t("streams.msgs.pageSize")}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>

          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              applyFilter();
            }}
          >
            <Input
              data-testid="msgs-filter"
              aria-label={t("streams.msgs.filter")}
              placeholder={t("streams.msgs.filter")}
              value={filterDraft}
              className="h-8 w-40"
              onChange={(e) => setFilterDraft(e.target.value)}
            />
            <Button size="sm" variant="outline" type="submit" data-testid="msgs-filter-apply" className="h-8">
              {t("streams.msgs.filterApply")}
            </Button>
          </form>

          <Button size="sm" variant="outline" data-testid="msgs-close" onClick={onClose}>
            {t("streams.msgs.close")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Message table (rows are ≤ pageSize ≤ 200 — plain rows suffice) */}
        <div className="flex min-w-0 flex-1 flex-col" aria-busy={loading}>
          <div
            data-testid="msgs-table-header"
            role="row"
            className={`grid h-8 shrink-0 items-center border-b border-border px-3 text-xs font-medium text-[var(--fg-muted)] ${GRID_COLS}`}
          >
            <span className="text-right">{t("streams.msgs.colSeq")}</span>
            <span>{t("streams.msgs.colSubject")}</span>
            <span className="text-right">{t("streams.msgs.colSize")}</span>
            <span>{t("streams.msgs.colTime")}</span>
            <span />
          </div>

          {loading ? (
            <div data-testid="msgs-loading" className="flex flex-col gap-1 p-3">
              {Array.from({ length: 8 }, (_, i) => (
                <div
                  key={i}
                  className="h-6 animate-pulse rounded bg-[var(--accent-soft)]"
                  style={{ width: `${92 - (i % 4) * 12}%` }}
                />
              ))}
            </div>
          ) : msgs.length === 0 ? (
            <div
              data-testid="msgs-empty"
              className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center"
            >
              <p className="text-sm font-medium">{t("streams.msgs.empty")}</p>
              {filter !== "" && (
                <p className="text-xs text-[var(--fg-muted)]">
                  {t("streams.msgs.emptyFiltered", { filter })}
                </p>
              )}
            </div>
          ) : (
            <div data-testid="msgs-table" className="min-h-0 flex-1 overflow-auto font-mono text-xs">
              {rows.map((row) =>
                row.kind === "hole" ? (
                  <div
                    key={row.key}
                    data-testid="msg-hole"
                    className={`grid h-7 items-center border-b border-[var(--border-soft)] px-3 italic text-[var(--fg-faint)] ${GRID_COLS}`}
                  >
                    <span className="col-span-2 truncate">
                      {t("streams.msgs.deletedMarker", { seq: row.seq })}
                    </span>
                  </div>
                ) : (
                  <div
                    key={row.key}
                    data-testid={`msg-row-${row.msg.seq}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected?.seq === row.msg.seq}
                    onClick={() => setSelected(row.msg)}
                    onKeyDown={(e) => {
                      // M6 Task 8 ⑲: role="button" rows answer Space as well
                      // as Enter; preventDefault stops the list scroll.
                      if (e.key === "Enter" || e.key === " ") {
                        if (e.key === " ") e.preventDefault();
                        setSelected(row.msg);
                      }
                    }}
                    className={`grid h-7 cursor-pointer items-center border-b border-[var(--border-soft)] px-3 hover:bg-[var(--accent-soft)] ${
                      selected?.seq === row.msg.seq ? "bg-[var(--accent-soft)]" : ""
                    } ${GRID_COLS}`}
                  >
                    <span className="text-right tabular-nums text-[var(--fg-faint)]">
                      #{row.msg.seq}
                    </span>
                    <span className="truncate" title={row.msg.subject}>
                      {row.msg.subject}
                    </span>
                    <span className="text-right tabular-nums">{formatBytes(row.msg.payload_size)}</span>
                    <span className="truncate text-[var(--fg-muted)]">
                      {formatTime(row.msg.timestamp_ms)}
                    </span>
                    <span className="flex items-center justify-end gap-1">
                      {!row.msg.is_utf8 && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          {t("messages.sessions.binaryTag")}
                        </Badge>
                      )}
                      {row.msg.truncated && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                          {t("streams.msgs.truncated")}
                        </Badge>
                      )}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Right-side detail for the clicked row */}
        {viewed && (
          <aside
            data-testid="msgs-detail"
            aria-busy={detailLoading}
            className="flex w-[420px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3"
          >
            <div className="flex items-center gap-2">
              <h3 data-testid="msgs-detail-title" className="text-sm font-semibold">
                {t("messages.sessions.detailTitle", { seq: viewed.seq })}
              </h3>
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="destructive" data-testid="msg-delete" onClick={handleDelete}>
                  {t("streams.msgs.delete")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="msgs-detail-close"
                  onClick={() => setSelected(null)}
                >
                  {t("streams.msgs.close")}
                </Button>
              </div>
            </div>

            <div data-testid="msgs-detail-meta" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-[var(--fg-muted)]">{t("streams.msgs.colSubject")}</span>
              <span className="font-mono break-all">{viewed.subject}</span>
              <span className="text-[var(--fg-muted)]">{t("streams.msgs.colSize")}</span>
              <span className="font-mono">{formatBytes(viewed.payload_size)}</span>
              <span className="text-[var(--fg-muted)]">{t("streams.msgs.colTime")}</span>
              <span className="font-mono">{formatTime(viewed.timestamp_ms)}</span>
              {viewed.truncated && (
                <>
                  <span className="text-[var(--fg-muted)]">{t("streams.msgs.truncated")}</span>
                  <span className="text-[var(--fg-muted)]">{t("streams.msgs.truncatedHint")}</span>
                </>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-medium">{t("messages.headers")}</h4>
              {Object.entries(viewed.headers ?? {}).length > 0 ? (
                <table data-testid="msg-detail-headers" className="w-full text-xs">
                  <tbody>
                    {Object.entries(viewed.headers ?? {}).map(([k, vs]) => (
                      <tr key={k} className="border-b border-[var(--border-soft)]">
                        <td className="py-1 pr-4 align-top font-medium whitespace-nowrap">{k}</td>
                        <td className="py-1 font-mono break-all">{(vs ?? []).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-[var(--fg-muted)]">{t("messages.sessions.noHeaders")}</p>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-medium">{t("messages.payload")}</h4>
              {detailLoading ? (
                <div
                  data-testid="msgs-detail-loading"
                  className="h-24 animate-pulse rounded-md border border-border bg-[var(--accent-soft)]"
                />
              ) : (
                <PayloadView
                  b64={viewed.payload_b64}
                  isUtf8={viewed.is_utf8}
                  downloadName={`stream-${stream}-msg-${viewed.seq}.bin`}
                  hexLimit={HEX_PREVIEW_BYTES * 2}
                  testId="msg-detail-payload"
                />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
