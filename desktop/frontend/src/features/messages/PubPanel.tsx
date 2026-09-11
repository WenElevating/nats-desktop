import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { Publish, Request, type PubForm, type ReqForm } from "../../lib/bindings";
import { toBase64, fromBase64Bytes, bytesToHex } from "../../lib/base64";
import {
  PAYLOAD_MAX_BYTES,
  PAYLOAD_WARN_BYTES,
  formatBytes,
  headersToWire,
  pubSchema,
  utf8Length,
  type HeaderRow,
} from "./schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

type Mode = "publish" | "request";

/** One finished send, as shown in the in-memory history (last 20, §6.3). */
interface HistoryEntry {
  id: number;
  mode: Mode;
  subject: string;
  ok: boolean;
  ms: number;
}

/** The last publish / request answer, tagged with the mode it came from. */
type SendResult =
  | { mode: "publish"; res: Awaited<ReturnType<typeof Publish>> }
  | { mode: "request"; res: Awaited<ReturnType<typeof Request>> };

const emptyDraft = () => ({
  mode: "publish" as Mode,
  subject: "",
  payload: "",
  jetstream: false,
  msgId: "",
  timeout: "5000",
});

/** First zod issue message per top-level field (messages are i18n keys). */
function collectErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Response payload decode: strict UTF-8 text when the bytes are valid UTF-8,
 * otherwise a hex preview with the binary label (§6.3 binary branch). Hex is
 * truncated for display so a multi-megabyte reply cannot flood the DOM.
 */
function decodeResponse(payload: string | null | undefined) {
  const bytes = fromBase64Bytes(payload ?? "");
  if (bytes.length === 0) return { text: "" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    const hex = bytesToHex(bytes);
    return {
      binary: true,
      hex: hex.length > 4096 ? `${hex.slice(0, 4096)}…` : hex,
      bytes: bytes.length,
    };
  }
}

/**
 * The publish/request workbench (spec §6.3): subject + dynamic header rows +
 * monospace payload with Format JSON, the JetStream acked-publish toggle with
 * its Nats-Msg-Id dedupe hint, size policy (warn 1–8 MiB with a confirm
 * dialog, reject > 8 MiB), the response panel for request mode, and the
 * last-20 in-memory send history. Sending is gated on the live connection.
 */
export function PubPanel() {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [draft, setDraft] = useState(emptyDraft);
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sizeRejected, setSizeRejected] = useState<number | null>(null);
  const [sizeAsk, setSizeAsk] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const patch = (p: Partial<ReturnType<typeof emptyDraft>>) =>
    setDraft((d) => ({ ...d, ...p }));

  const timeoutMs = Number.parseInt(draft.timeout, 10) || 0;

  const addRow = () => setRows((r) => [...r, { key: "", value: "" }]);
  const patchRow = (i: number, p: Partial<HeaderRow>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...p } : row)));
  const removeRow = (i: number) => setRows((r) => r.filter((_, j) => j !== i));

  const formatJson = () => {
    try {
      patch({ payload: JSON.stringify(JSON.parse(draft.payload), null, 2) });
    } catch {
      toast.error(t("messages.jsonInvalid"));
    }
  };

  const addHistory = (entry: Omit<HistoryEntry, "id">) =>
    setHistory((h) => [{ ...entry, id: Date.now() + Math.random() }, ...h].slice(0, 20));

  /** Send after all gates passed: builds the wire form (snake_case Go model,
   * base64 payload) and records the outcome in the result panel + history. */
  const doSend = async () => {
    setSending(true);
    try {
      const wire = headersToWire(rows) ?? {};
      if (draft.mode === "publish") {
        if (draft.jetstream && draft.msgId.trim()) {
          const id = draft.msgId.trim();
          wire["Nats-Msg-Id"] = [...(wire["Nats-Msg-Id"] ?? []), id];
        }
        const form: PubForm = {
          subject: draft.subject,
          headers: Object.keys(wire).length > 0 ? wire : null,
          payload: toBase64(draft.payload),
          jetstream: draft.jetstream,
          timeout_ms: timeoutMs,
        };
        const res = await Publish(form);
        setResult({ mode: "publish", res });
        addHistory({ mode: "publish", subject: draft.subject, ok: res.ok, ms: res.elapsed_ms });
      } else {
        const form: ReqForm = {
          subject: draft.subject,
          headers: Object.keys(wire).length > 0 ? wire : null,
          payload: toBase64(draft.payload),
          timeout_ms: timeoutMs,
        };
        const res = await Request(form);
        setResult({ mode: "request", res });
        addHistory({ mode: "request", subject: draft.subject, ok: res.ok, ms: res.elapsed_ms });
      }
    } catch (err) {
      console.error(`${draft.mode} failed:`, err);
      const text = err instanceof Error ? err.message : String(err);
      toast.error(
        t(draft.mode === "publish" ? "messages.pubFailed" : "messages.reqFailed", { error: text }),
      );
    } finally {
      setSending(false);
    }
  };

  /** Submit gate order: schema (subject) → hard size reject → warn dialog. */
  const onSubmit = () => {
    const parsed = pubSchema.safeParse({ ...draft, headers: rows, timeoutMs });
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    const bytes = utf8Length(draft.payload);
    if (bytes > PAYLOAD_MAX_BYTES) {
      setSizeRejected(bytes);
      return;
    }
    if (bytes >= PAYLOAD_WARN_BYTES) {
      setSizeAsk(bytes);
      return;
    }
    void doSend();
  };

  const isRequest = draft.mode === "request";

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="pub-panel">
      {/* Mode toggle (publish vs request) */}
      <div role="group" className="flex w-fit gap-1 rounded-lg border border-border p-1">
        {(["publish", "request"] as const).map((m) => (
          <button
            key={m}
            type="button"
            data-testid={`mode-${m}`}
            aria-pressed={draft.mode === m}
            onClick={() => {
              patch({ mode: m });
              setResult(null);
            }}
            className={`rounded-md px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
              draft.mode === m
                ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                : "text-[var(--fg-muted)] hover:text-foreground"
            }`}
          >
            {t(m === "publish" ? "messages.modePublish" : "messages.modeRequest")}
          </button>
        ))}
      </div>

      {/* Subject */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pub-subject">{t("messages.subject")}</Label>
        <Input
          id="pub-subject"
          value={draft.subject}
          placeholder={t("messages.subjectPlaceholder")}
          className="font-mono"
          aria-invalid={errors.subject ? true : undefined}
          onChange={(e) => {
            patch({ subject: e.target.value });
            setErrors((prev) => ({ ...prev, subject: "" }));
          }}
        />
        {errors.subject && (
          <p role="alert" data-testid="subject-error" className="text-xs text-[var(--danger-fg)]">
            {t(errors.subject)}
          </p>
        )}
      </div>

      {/* Headers (dynamic rows) */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("messages.headers")}</span>
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              aria-label={t("messages.headerName")}
              placeholder={t("messages.headerName")}
              value={row.key}
              className="font-mono"
              onChange={(e) => patchRow(i, { key: e.target.value })}
            />
            <Input
              aria-label={t("messages.headerValue")}
              placeholder={t("messages.headerValue")}
              value={row.value}
              className="font-mono"
              onChange={(e) => patchRow(i, { value: e.target.value })}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("messages.removeHeader")}
              onClick={() => removeRow(i)}
            >
              <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="w-fit" onClick={addRow}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          {t("messages.addHeader")}
        </Button>
      </div>

      {/* Payload + Format JSON */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="pub-payload">{t("messages.payload")}</Label>
          <span data-testid="payload-bytes" className="text-xs text-[var(--fg-faint)]">
            {t("messages.payloadBytes", { bytes: utf8Length(draft.payload) })}
          </span>
        </div>
        <textarea
          id="pub-payload"
          value={draft.payload}
          onChange={(e) => {
            patch({ payload: e.target.value });
            setSizeRejected(null);
          }}
          rows={6}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-border bg-panel p-2 font-mono text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        {sizeRejected !== null && (
          <p role="alert" data-testid="size-reject" className="text-xs text-[var(--danger-fg)]">
            {t("messages.sizeReject", { size: formatBytes(sizeRejected) })}
          </p>
        )}
        <Button variant="outline" size="sm" className="w-fit" onClick={formatJson}>
          {t("messages.formatJson")}
        </Button>
      </div>

      {/* JetStream acked publish (publish mode only) + Nats-Msg-Id dedupe */}
      {!isRequest && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <Switch
              id="pub-js"
              data-testid="js-switch"
              checked={draft.jetstream}
              onCheckedChange={(v) => patch({ jetstream: v })}
            />
            <Label htmlFor="pub-js">{t("messages.publishJs")}</Label>
          </div>
          {draft.jetstream && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pub-msgid">{t("messages.msgId")}</Label>
              <Input
                id="pub-msgid"
                value={draft.msgId}
                className="font-mono"
                onChange={(e) => patch({ msgId: e.target.value })}
              />
              <p data-testid="msgid-hint" className="text-xs text-[var(--fg-faint)]">
                {t("messages.msgIdHint")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Timeout (request wait / JS ack wait; <=0 falls back to settings) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pub-timeout">{t("messages.timeout")}</Label>
        <Input
          id="pub-timeout"
          type="number"
          min={0}
          value={draft.timeout}
          onChange={(e) => patch({ timeout: e.target.value })}
        />
      </div>

      {/* Action row: gated on the live connection (§6.3) */}
      <div className="flex items-center gap-3">
        <Button data-testid="send-button" onClick={onSubmit} disabled={!connected || sending}>
          {t(isRequest ? "messages.request" : "messages.publish")}
        </Button>
        {!connected && (
          <p data-testid="not-connected" className="text-xs text-[var(--fg-muted)]">
            {t("messages.notConnected")}
          </p>
        )}
      </div>

      {/* Publish result (stream / seq / duplicate badges on the JS path) */}
      {result?.mode === "publish" &&
        (result.res.ok ? (
          <div data-testid="pub-result" role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-panel p-3 text-sm">
            <span className="font-medium text-[var(--ok-fg)]">{t("messages.published")}</span>
            <Badge variant="secondary">{t("messages.duration", { ms: result.res.elapsed_ms })}</Badge>
            {result.res.jetstream && result.res.stream && (
              <Badge>{t("messages.stream", { name: result.res.stream })}</Badge>
            )}
            {result.res.jetstream && result.res.sequence != null && (
              <Badge>{t("messages.seq", { seq: result.res.sequence })}</Badge>
            )}
            {result.res.jetstream && result.res.duplicate && (
              <Badge variant="outline">{t("messages.dup")}</Badge>
            )}
          </div>
        ) : (
          <p data-testid="pub-error" role="alert" className="rounded-md border border-border bg-panel p-3 text-sm text-[var(--danger-fg)]">
            {t("messages.pubFailed", { error: result.res.error ?? "" })}
          </p>
        ))}

      {/* Request result: response payload (text or hex) / no-responder / error */}
      {result?.mode === "request" &&
        (result.res.ok ? (
          <div data-testid="req-result" role="status" className="flex flex-col gap-2 rounded-md border border-border bg-panel p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{t("messages.response")}</span>
              <span data-testid="req-duration" className="text-xs text-[var(--fg-muted)]">
                {t("messages.duration", { ms: result.res.elapsed_ms })}
              </span>
            </div>
            {(() => {
              const decoded = decodeResponse(result.res.payload);
              return "text" in decoded ? (
                <pre data-testid="req-payload" className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
                  {decoded.text}
                </pre>
              ) : (
                <div data-testid="req-payload-binary" className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--fg-muted)]">
                    {t("messages.binaryPreview", { bytes: decoded.bytes })}
                  </span>
                  <pre className="overflow-x-auto font-mono text-xs">{decoded.hex}</pre>
                </div>
              );
            })()}
          </div>
        ) : result.res.no_responder ? (
          <div data-testid="no-responder" role="alert" className="flex items-center gap-2 rounded-md border border-border bg-panel p-3 text-sm">
            <span className="font-medium text-[var(--warn-fg)]">{t("messages.noResponder")}</span>
            <span className="text-xs text-[var(--fg-muted)]">
              {t("messages.elapsed", { ms: result.res.elapsed_ms })}
            </span>
          </div>
        ) : (
          <p data-testid="req-error" role="alert" className="rounded-md border border-border bg-panel p-3 text-sm text-[var(--danger-fg)]">
            {t("messages.reqFailed", { error: result.res.error ?? "" })}
          </p>
        ))}

      {/* History: last 20 sends, in-memory only (§6.3) */}
      <div data-testid="pub-history" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t("messages.history")}</h3>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="clear-history"
              onClick={() => setHistory([])}
            >
              {t("messages.clearHistory")}
            </Button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-[var(--fg-muted)]">{t("messages.historyEmpty")}</p>
        ) : (
          <ScrollArea className="max-h-48 rounded-md border border-border">
            <ul className="flex flex-col divide-y divide-[var(--border-soft)]">
              {history.map((h) => (
                <li key={h.id} data-testid="history-item" className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs">
                  <Badge variant="secondary">
                    {t(h.mode === "publish" ? "messages.modePublish" : "messages.modeRequest")}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate">{h.subject}</span>
                  <span className={h.ok ? "text-[var(--ok-fg)]" : "text-[var(--danger-fg)]"}>
                    {t("messages.duration", { ms: h.ms })}
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>

      {/* 1–8 MiB confirm dialog: the send happens only after confirmation */}
      <AlertDialog
        open={sizeAsk !== null}
        onOpenChange={(o) => {
          if (!o) setSizeAsk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("messages.sizeWarnTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("messages.sizeWarn", { size: sizeAsk !== null ? formatBytes(sizeAsk) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setSizeAsk(null); void doSend(); }}>
              {t("common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
