import { useEffect, useState } from "react";
import {
  ArrowRightLeft,
  CircleSlash,
  Database,
  Inbox,
  LogIn,
  LogOut,
  Plus,
  Radio,
  Trash2,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import { GetSettings, Trace, type TraceForm, type TraceHop } from "../../lib/bindings";
import { toBase64 } from "../../lib/base64";
import { headersToWire, traceSchema, type HeaderRow } from "./schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** Icon per hop kind (the Go TraceHop closed set); unknown kinds fall back to
 * the generic route glyph so a future server kind still renders. */
const kindIcons: Record<string, typeof Waypoints> = {
  ingress: LogIn,
  egress: LogOut,
  mapping: ArrowRightLeft,
  service_import: Inbox,
  stream_export: Radio,
  jetstream: Database,
  no_interest: CircleSlash,
};

/** One node of the trace tree (spec §6.5): uppercase mono kind badge, mono
 * detail, children indented under a guide line — natscli `nats trace` style. */
function HopNode({ hop, depth }: { hop: TraceHop; depth: number }) {
  const Icon = kindIcons[hop.kind] ?? Waypoints;
  return (
    <li data-testid="trace-hop" data-kind={hop.kind} data-depth={depth} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="font-mono uppercase">
          <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
          {hop.kind.toUpperCase()}
        </Badge>
        {hop.detail && (
          <span className="min-w-0 flex-1 break-all font-mono text-xs">{hop.detail}</span>
        )}
      </div>
      {(hop.children?.length ?? 0) > 0 && (
        <ul className="ml-5 flex flex-col gap-1 border-l border-[var(--border-soft)] pl-3">
          {hop.children!.map((child, i) => (
            <HopNode key={i} hop={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The message path trace tab (spec §6.5): subject + optional header rows +
 * optional payload, the "trace only" toggle (default on — the probe carries
 * Nats-Trace-Only and never reaches the final subject), and a timeout field
 * seeded from request_timeout_seconds like PubPanel. Running calls the Trace
 * binding (NATS Server 2.11+ server-side tracing) and renders the returned
 * TraceHop tree; failures toast the verbatim server error. Gated on the live
 * connection.
 */
export function TracePanel() {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [subject, setSubject] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [payload, setPayload] = useState("");
  const [traceOnly, setTraceOnly] = useState(true);
  const [timeout, setTimeout_] = useState("5000");
  const [subjectError, setSubjectError] = useState("");
  const [running, setRunning] = useState(false);
  const [tree, setTree] = useState<TraceHop | null>(null);

  // Seed the timeout field from the user's request_timeout_seconds setting —
  // the same pattern as PubPanel: a failed load (outside Wails, tests) keeps
  // the 5s fallback, and the field stays editable for per-run overrides.
  useEffect(() => {
    let alive = true;
    GetSettings()
      .then((s) => {
        if (!alive) return;
        const sec = s.behavior.request_timeout_seconds;
        const ms = sec > 0 ? sec * 1000 : 5000;
        setTimeout_(String(ms));
      })
      .catch(() => {
        /* outside Wails (tests/plain browser) — the default stands */
      });
    return () => {
      alive = false;
    };
  }, []);

  const timeoutMs = Number.parseInt(timeout, 10) || 0;

  const addRow = () => setRows((r) => [...r, { key: "", value: "" }]);
  const patchRow = (i: number, p: Partial<HeaderRow>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...p } : row)));
  const removeRow = (i: number) => setRows((r) => r.filter((_, j) => j !== i));

  /** Run after the gates passed: builds the wire form (snake_case Go model,
   * base64 payload, deliver = !traceOnly) and renders the returned hop tree. */
  const doTrace = async () => {
    setRunning(true);
    try {
      const form: TraceForm = {
        subject,
        headers: headersToWire(rows),
        payload: toBase64(payload),
        deliver: !traceOnly,
        timeout_ms: timeoutMs,
      };
      const hop = await Trace(form);
      setTree(hop);
    } catch (err) {
      console.error("trace failed:", err);
      const text = err instanceof Error ? err.message : String(err);
      toast.error(t("messages.trace.runFailed", { error: text }));
    } finally {
      setRunning(false);
    }
  };

  const onRun = () => {
    const parsed = traceSchema.safeParse({ subject, headers: rows, payload, timeoutMs });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (String(issue?.path[0] ?? "") === "subject") setSubjectError(issue.message);
      return;
    }
    setSubjectError("");
    void doTrace();
  };

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="trace-panel">
      {/* Subject */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="trace-subject">{t("messages.subject")}</Label>
        <Input
          id="trace-subject"
          value={subject}
          placeholder={t("messages.subjectPlaceholder")}
          className="font-mono"
          aria-invalid={subjectError ? true : undefined}
          onChange={(e) => {
            setSubject(e.target.value);
            setSubjectError("");
          }}
        />
        {subjectError && (
          <p role="alert" data-testid="subject-error" className="text-xs text-[var(--danger-fg)]">
            {t(subjectError)}
          </p>
        )}
      </div>

      {/* Headers (dynamic rows, same shape as the publish panel) */}
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

      {/* Payload (optional: the probe body) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="trace-payload">{t("messages.payload")}</Label>
        <textarea
          id="trace-payload"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-border bg-panel p-2 font-mono text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      {/* Trace only (default on = the message is never actually delivered) */}
      <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
        <div className="flex items-center gap-2">
          <Switch
            id="trace-only"
            data-testid="trace-only-switch"
            checked={traceOnly}
            onCheckedChange={(v) => setTraceOnly(v)}
          />
          <Label htmlFor="trace-only">{t("messages.trace.traceOnly")}</Label>
        </div>
        <p data-testid="trace-only-hint" className="text-xs text-[var(--fg-faint)]">
          {t("messages.trace.traceOnlyHint")}
        </p>
      </div>

      {/* Timeout (each trace-response wait; <=0 falls back to settings) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="trace-timeout">{t("messages.timeout")}</Label>
        <Input
          id="trace-timeout"
          type="number"
          min={0}
          value={timeout}
          onChange={(e) => setTimeout_(e.target.value)}
        />
      </div>

      {/* Action row: gated on the live connection (§6.5) */}
      <div className="flex items-center gap-3">
        <Button data-testid="trace-run" onClick={onRun} disabled={!connected || running}>
          {t(running ? "messages.trace.running" : "messages.trace.run")}
        </Button>
        {!connected && (
          <p data-testid="not-connected" className="text-xs text-[var(--fg-muted)]">
            {t("messages.notConnected")}
          </p>
        )}
      </div>

      {/* The unfolded hop tree (kind badge + mono detail, recursive indent) */}
      {tree && (
        <div
          data-testid="trace-tree"
          role="status"
          className="flex flex-col gap-2 rounded-md border border-border bg-panel p-3"
        >
          <span className="text-sm font-medium">{t("messages.trace.resultTitle")}</span>
          <ul className="flex flex-col gap-1">
            <HopNode hop={tree} depth={0} />
          </ul>
        </div>
      )}
    </div>
  );
}
