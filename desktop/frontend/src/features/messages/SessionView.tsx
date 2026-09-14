import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "../../app/i18n";
import { PushMode, type SessionState } from "../../lib/bindings";
import { bytesToHex, fromBase64, fromBase64Bytes } from "../../lib/base64";
import { formatBytes } from "../../lib/format";
import { PayloadView } from "../../lib/payload";
import type { MsgOut } from "./useSessions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Fixed-equal rows (spec §6.4 / brief): 28px per row, 8 overscan, so the
// virtualizer never needs per-row measurement and huge buffers stay cheap.
const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const HEX_PREVIEW_CHARS = 64;
const TEXT_PREVIEW_CHARS = 200;

export interface SessionViewProps {
  session: SessionState;
  msgs: MsgOut[];
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  onClose: () => void;
}

/** Status dot color per session state: running green / paused orange / closed gray. */
export function StateDot({ state }: { state: string }) {
  const color =
    state === "running"
      ? "bg-[var(--ok)]"
      : state === "paused"
        ? "bg-[var(--warn)]"
        : "bg-[var(--fg-faint)]";
  return (
    <span
      data-state={state}
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${color}`}
    />
  );
}

/** i18n key for the closed set running | paused | closed (running fallback). */
export function stateKey(state: string): string {
  if (state === "paused") return "messages.sessions.paused";
  if (state === "closed") return "messages.sessions.closed";
  return "messages.sessions.running";
}

/** Rate copy "x msg/s": whole rates unformatted, fractional to one decimal. */
export function rateLabel(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
}

/** ISO timestamp reduced to its HH:MM:SS part for the narrow list row. */
function timeOnly(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

/** Row preview content: UTF-8 text, or hex with the binary marker. Truncated
 * so one giant payload cannot flood the 28px row. */
function rowPreview(m: MsgOut): { binary: boolean; text: string } {
  if (!m.is_utf8) {
    const hex = bytesToHex(fromBase64Bytes(m.payload_b64));
    return {
      binary: true,
      text: hex.length > HEX_PREVIEW_CHARS ? `${hex.slice(0, HEX_PREVIEW_CHARS)}…` : hex,
    };
  }
  const text = fromBase64(m.payload_b64);
  return {
    binary: false,
    text: text.length > TEXT_PREVIEW_CHARS ? `${text.slice(0, TEXT_PREVIEW_CHARS)}…` : text,
  };
}

/**
 * Detail dialog body (spec §6.4): metadata, the headers table, and the full
 * payload via the shared PayloadView (mono-font text / hex-text toggle +
 * Blob download for binary). Keyed by the message so view state resets per
 * selection.
 */
function MessageDetail({ msg }: { msg: MsgOut }) {
  const { t } = useTranslation();

  const headerEntries = Object.entries(msg.headers ?? {});

  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="detail-meta"
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs"
      >
        <span className="text-[var(--fg-muted)]">{t("messages.subject")}</span>
        <span className="font-mono break-all">{msg.subject}</span>
        <span className="text-[var(--fg-muted)]">{t("messages.sessions.time")}</span>
        <span className="font-mono">{msg.timestamp}</span>
        <span className="text-[var(--fg-muted)]">{t("messages.sessions.size")}</span>
        <span className="font-mono">{formatBytes(msg.payload_size)}</span>
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">{t("messages.headers")}</h4>
        {headerEntries.length > 0 ? (
          <table data-testid="detail-headers" className="w-full text-xs">
            <tbody>
              {headerEntries.map(([k, vs]) => (
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
        <PayloadView
          b64={msg.payload_b64}
          isUtf8={msg.is_utf8}
          downloadName={`session-${msg.session_id}-msg-${msg.seq}.bin`}
          toggle
          testId="detail-payload"
        />
      </div>
    </div>
  );
}

/**
 * One subscription session (spec §6.4): status bar (state dot, push-mode
 * badge, rate/total, dropped badge, buffer count) with the
 * pause/resume/clear/close actions, and the virtualized monospace message
 * list whose rows open the detail dialog.
 */
export function SessionView({ session, msgs, onPause, onResume, onClear, onClose }: SessionViewProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<MsgOut | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: msgs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  return (
    <div data-testid="session-view" className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Status bar + actions (optimistic state arrives via useSessions) */}
      <div
        data-testid="session-status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-panel px-3 py-2"
      >
        <StateDot state={session.state} />
        <span data-testid="session-state" className="text-sm font-medium">
          {t(stateKey(session.state))}
        </span>
        <Badge variant="outline" data-testid="session-mode">
          {t(
            session.push_mode === PushMode.PushBatch
              ? "messages.sessions.modeBatch"
              : "messages.sessions.modeRealtime",
          )}
        </Badge>
        <span data-testid="session-rate" className="text-xs text-[var(--fg-muted)]">
          {t("messages.sessions.rate", { rate: rateLabel(session.rate_msg_s) })}
        </span>
        <span data-testid="session-total" className="text-xs text-[var(--fg-muted)]">
          {t("messages.sessions.total", { n: session.total })}
        </span>
        {/* Header-filtered receipts (received == total + filtered); a state
         * event missing the newer field counts as 0. */}
        <span data-testid="session-filtered" className="text-xs text-[var(--fg-muted)]">
          {t("messages.sessions.filteredCount", { count: session.filtered ?? 0 })}
        </span>
        {session.dropped > 0 && (
          <Badge variant="destructive" data-testid="session-dropped">
            {t("messages.sessions.dropped", { n: session.dropped })}
          </Badge>
        )}
        <span data-testid="msg-count" className="text-xs text-[var(--fg-faint)]">
          {t("messages.sessions.msgsCount", { n: msgs.length })}
        </span>
        {session.error && (
          <span className="text-xs text-[var(--danger-fg)]">
            {t("messages.sessions.sessionError", { error: session.error })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {session.state === "running" && (
            <Button size="sm" variant="outline" data-testid="session-pause" onClick={onPause}>
              {t("messages.sessions.pause")}
            </Button>
          )}
          {session.state === "paused" && (
            <Button size="sm" variant="outline" data-testid="session-resume" onClick={onResume}>
              {t("messages.sessions.resume")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            data-testid="session-clear"
            onClick={onClear}
            disabled={session.state === "closed"}
          >
            {t("messages.sessions.clear")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="session-close"
            onClick={onClose}
            disabled={session.state === "closed"}
          >
            {t("messages.sessions.closeSession")}
          </Button>
        </div>
      </div>

      {/* Virtualized message list (fixed 28px rows, overscan 8, monospace) */}
      {msgs.length === 0 ? (
        <p data-testid="session-list-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("messages.sessions.listEmpty")}
        </p>
      ) : (
        <div
          ref={parentRef}
          data-testid="session-list"
          className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
        >
          <div
            className="relative w-full font-mono text-xs"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const m = msgs[vi.index];
              if (!m) return null;
              const preview = rowPreview(m);
              return (
                <div
                  key={vi.key}
                  data-testid="session-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(m)}
                  onKeyDown={(e) => {
                    // M6 Task 8 ⑲: role="button" rows answer Space as well as
                    // Enter; preventDefault stops the list viewport scroll.
                    if (e.key === "Enter" || e.key === " ") {
                      if (e.key === " ") e.preventDefault();
                      setSelected(m);
                    }
                  }}
                  className="absolute left-0 flex w-full cursor-pointer items-center gap-3 px-3 hover:bg-[var(--accent-soft)]"
                  style={{ height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="w-14 shrink-0 text-right text-[var(--fg-faint)]">
                    #{m.seq}
                  </span>
                  <span className="w-16 shrink-0 text-[var(--fg-faint)]">
                    {timeOnly(m.timestamp)}
                  </span>
                  {preview.binary && (
                    <Badge variant="outline" className="shrink-0">
                      {t("messages.sessions.binaryTag")}
                    </Badge>
                  )}
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      preview.binary ? "text-[var(--fg-muted)]" : ""
                    }`}
                  >
                    {preview.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Detail dialog for the clicked row */}
      <Dialog open={selected !== null} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("messages.sessions.detailTitle", { seq: selected?.seq ?? 0 })}
            </DialogTitle>
          </DialogHeader>
          {selected && <MessageDetail key={`${selected.session_id}:${selected.seq}`} msg={selected} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
