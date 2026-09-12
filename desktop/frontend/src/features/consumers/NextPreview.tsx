import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { PreviewNext, type NextMsg } from "../../lib/bindings";
import { PayloadView } from "../../lib/payload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Closed batch bounds (spec §6.7 拉取预览批量 1–256; Go previewBatchMax). */
export const PREVIEW_BATCH_MAX = 256;
export const PREVIEW_BATCH_DEFAULT = 10;

export interface NextPreviewProps {
  stream: string;
  name: string;
  /** A paused consumer cannot pull (AC-012): the fetch button is disabled and
   * the panel explains why instead of letting the server reject. */
  paused: boolean;
  /** Close request (returns to the detail pane). */
  onDone?: () => void;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Pull preview panel (spec §6.7): fetch the next `batch` messages through
 * PreviewNext (default 10, closed 1–256 set enforced client-side) with an
 * auto-ack switch that defaults OFF (spec: 默认不 ack，除非用户显式开启).
 * Each message card renders the headers table, the seq + delivery counters
 * and the shared PayloadView (mono text / hex + raw download).
 */
export function NextPreview({ stream, name, paused, onDone }: NextPreviewProps) {
  const { t } = useTranslation();
  const [batch, setBatch] = useState(String(PREVIEW_BATCH_DEFAULT));
  const [autoAck, setAutoAck] = useState(false);
  const [messages, setMessages] = useState<NextMsg[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const fetchBatch = async () => {
    if (pending || paused) return;
    const n = Number(batch.trim());
    if (!Number.isInteger(n) || n < 1 || n > PREVIEW_BATCH_MAX) {
      setError(t("consumers.preview.batchInvalid"));
      return;
    }
    setError("");
    setPending(true);
    try {
      const res = await PreviewNext(stream, name, n, autoAck);
      if (res?.error_code) {
        // Server原文 inline (paused consumer / not a pull consumer / …).
        setError(res.error || res.error_code);
        setMessages(null);
        return;
      }
      setError("");
      setMessages(res?.messages ?? []);
    } catch (err) {
      setError(errText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      data-testid="next-preview"
      aria-busy={pending}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{t("consumers.preview.title")}</h2>
        <span className="truncate text-xs text-[var(--fg-muted)]">
          {stream} / {name}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--fg-muted)]">
            {t("consumers.preview.batch")}
            <Input
              data-testid="next-preview-batch"
              aria-label={t("consumers.preview.batch")}
              inputMode="numeric"
              className="h-8 w-16"
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
            />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              data-testid="next-preview-autoack"
              checked={autoAck}
              onChange={(e) => setAutoAck(e.target.checked)}
            />
            {t("consumers.preview.autoAck")}
          </label>
          <Button
            size="sm"
            data-testid="next-preview-fetch"
            disabled={pending || paused}
            onClick={() => void fetchBatch()}
          >
            {pending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {t("consumers.preview.fetch")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="next-preview-close"
            aria-label={t("common.close")}
            onClick={() => onDone?.()}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {paused && (
        <p data-testid="next-preview-paused" className="text-sm text-[var(--fg-muted)]">
          {t("consumers.preview.pausedHint")}
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-testid="next-preview-error"
          className="rounded-md border border-[var(--danger-fg)] px-3 py-2 text-sm text-[var(--danger-fg)]"
        >
          {error}
        </p>
      )}

      {messages !== null && messages.length === 0 && (
        <p data-testid="next-preview-empty" className="p-4 text-sm text-[var(--fg-muted)]">
          {t("consumers.preview.empty")}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {(messages ?? []).map((m) => (
          <article
            key={m.seq}
            data-testid={`next-msg-${m.seq}`}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              <span className="font-medium tabular-nums">#{m.seq}</span>
              <span className="font-mono">{m.subject}</span>
              <span className="text-[var(--fg-muted)]">
                {t("consumers.preview.delivered")}: {m.num_delivered}
              </span>
              <span className="text-[var(--fg-muted)]">
                {t("consumers.preview.pending")}: {m.num_pending}
              </span>
              {m.truncated && <span className="text-[var(--warn)]">{t("consumers.preview.truncated")}</span>}
            </div>
            {Object.keys(m.headers ?? {}).length > 0 && (
              <table data-testid={`next-headers-${m.seq}`} className="text-xs">
                <tbody>
                  {Object.entries(m.headers ?? {}).map(([k, vs]) => (
                    <tr key={k}>
                      <td className="pr-3 align-top font-mono font-medium">{k}</td>
                      <td className="font-mono break-all text-[var(--fg-muted)]">
                        {(vs ?? []).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PayloadView
              b64={m.payload_b64}
              isUtf8={m.is_utf8}
              downloadName={`${name}-${m.seq}.bin`}
              testId={`next-payload-${m.seq}`}
            />
          </article>
        ))}
      </div>
    </div>
  );
}
