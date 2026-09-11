import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import {
  GetSettings,
  PushMode,
  type JSPosition,
  type SessionSpec,
  type SessionState,
} from "../../lib/bindings";
import { SessionView, StateDot, rateLabel } from "./SessionView";
import { useSessions } from "./useSessions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The five JS positioning choices (spec §6.4); "none" = plain core NATS
 * subscription (no js_position on the wire). */
type JsMode = "none" | "all" | "new" | "start_sequence" | "start_time";

/** Build the wire JSPosition from the folded region's state. "none" yields
 * undefined (omitted from the spec → core subscription on the Go side); an
 * unusable start_time falls back to an empty string, which the server
 * rejects — the same as sending garbage, but only after an explicit choice. */
function buildJsPosition(mode: JsMode, startSeq: string, startTime: string): JSPosition | undefined {
  switch (mode) {
    case "all":
      return { mode: "all" };
    case "new":
      return { mode: "new" };
    case "start_sequence": {
      const seq = Number.parseInt(startSeq, 10);
      return { mode: "start_sequence", start_seq: Number.isFinite(seq) && seq > 0 ? seq : 0 };
    }
    case "start_time": {
      const d = startTime ? new Date(startTime) : null;
      return {
        mode: "start_time",
        start_time: d && !Number.isNaN(d.valueOf()) ? d.toISOString() : "",
      };
    }
    default:
      return undefined;
  }
}

/**
 * The subscription sessions tab (spec §6.4): a create form (subject, the
 * realtime/batch push toggle seeded from session_push_batching, and the
 * folded JetStream positioning region), a chip per session (subject + state
 * dot + rate/total/dropped), and the selected session's virtualized message
 * view. Creation is gated on the live connection — sessions survive only
 * while connected, so a disconnected manager is refused client-side too.
 */
export function SessionsPanel() {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";
  const { sessions, messages, create, pause, resume, clear, close } = useSessions();

  const [subject, setSubject] = useState("");
  const [batch, setBatch] = useState(false);
  const [jsOpen, setJsOpen] = useState(false);
  const [jsMode, setJsMode] = useState<JsMode>("none");
  const [startSeq, setStartSeq] = useState("");
  const [startTime, setStartTime] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default push mode comes from the user's session_push_batching setting
  // (realtime when false / unset); a failed load keeps the realtime default.
  useEffect(() => {
    let alive = true;
    GetSettings()
      .then((s) => {
        if (alive) setBatch(s.behavior.session_push_batching);
      })
      .catch(() => {
        /* outside Wails (tests/plain browser) — the default stands */
      });
    return () => {
      alive = false;
    };
  }, []);

  // The chip list is the source of truth for selection; fall back to the
  // first session (ListSessions is sorted by id) when none is pinned.
  const activeId = selectedId ?? sessions[0]?.id ?? null;
  const active = sessions.find((s) => s.id === activeId) ?? null;

  const onCreate = async () => {
    const subj = subject.trim();
    if (!subj || creating) return;
    setCreating(true);
    const spec: SessionSpec = {
      subject: subj,
      push_mode: batch ? PushMode.PushBatch : PushMode.PushRealtime,
      buffer_size: 0,
      js_position: buildJsPosition(jsMode, startSeq, startTime),
    };
    const st = await create(spec);
    setCreating(false);
    if (st) {
      setSelectedId(st.id);
      setSubject("");
    }
  };

  return (
    <div data-testid="sessions-panel" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {/* Create form (§6.4) — gated on the live connection */}
      <div data-testid="session-create-form" className="flex flex-col gap-3 rounded-md border border-border p-3">
        <div className="flex items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="session-subject">{t("messages.subject")}</Label>
            <Input
              id="session-subject"
              value={subject}
              placeholder={t("messages.subjectPlaceholder")}
              disabled={!connected}
              className="font-mono"
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          {/* Push mode toggle (realtime is the settings-driven default) */}
          <div role="group" aria-label={t("messages.sessions.pushMode")} className="flex gap-1 rounded-lg border border-border p-1">
            <button
              type="button"
              data-testid="push-realtime"
              aria-pressed={!batch}
              disabled={!connected}
              onClick={() => setBatch(false)}
              className={`rounded-md px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                !batch
                  ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                  : "text-[var(--fg-muted)] hover:text-foreground"
              }`}
            >
              {t("messages.sessions.pushRealtime")}
            </button>
            <button
              type="button"
              data-testid="push-batch"
              aria-pressed={batch}
              disabled={!connected}
              onClick={() => setBatch(true)}
              className={`rounded-md px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                batch
                  ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                  : "text-[var(--fg-muted)] hover:text-foreground"
              }`}
            >
              {t("messages.sessions.pushBatch")}
            </button>
          </div>

          <Button data-testid="session-create" onClick={onCreate} disabled={!connected || !subject.trim() || creating}>
            {t(creating ? "messages.sessions.creating" : "messages.sessions.create")}
          </Button>
        </div>

        {/* Folded JetStream positioning region (five-way, spec §6.4) */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="js-position-toggle"
            aria-expanded={jsOpen}
            onClick={() => setJsOpen((v) => !v)}
            className="flex w-fit items-center gap-1 text-sm text-[var(--fg-muted)] outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {jsOpen ? (
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            {t("messages.sessions.jsPosition")}
          </button>
          {jsOpen && (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="js-position-mode">{t("messages.sessions.jsPosition")}</Label>
                <select
                  id="js-position-mode"
                  data-testid="js-position-mode"
                  value={jsMode}
                  disabled={!connected}
                  onChange={(e) => setJsMode(e.target.value as JsMode)}
                  className="w-fit rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="none">{t("messages.sessions.jsNone")}</option>
                  <option value="all">{t("messages.sessions.jsAll")}</option>
                  <option value="new">{t("messages.sessions.jsNew")}</option>
                  <option value="start_sequence">{t("messages.sessions.jsStartSeq")}</option>
                  <option value="start_time">{t("messages.sessions.jsStartTime")}</option>
                </select>
              </div>
              {jsMode === "start_sequence" && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="js-start-seq">{t("messages.sessions.startSeqLabel")}</Label>
                  <Input
                    id="js-start-seq"
                    data-testid="js-start-seq"
                    type="number"
                    min={0}
                    value={startSeq}
                    disabled={!connected}
                    className="font-mono"
                    onChange={(e) => setStartSeq(e.target.value)}
                  />
                </div>
              )}
              {jsMode === "start_time" && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="js-start-time">{t("messages.sessions.startTimeLabel")}</Label>
                  <Input
                    id="js-start-time"
                    data-testid="js-start-time"
                    type="datetime-local"
                    value={startTime}
                    disabled={!connected}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}
          {!connected && (
            <p data-testid="sessions-not-connected" className="text-xs text-[var(--fg-muted)]">
              {t("messages.sessions.notConnected")}
            </p>
          )}
        </div>
      </div>

      {/* One chip per session: subject + state dot + rate/total + dropped badge */}
      {sessions.length > 0 ? (
        <div data-testid="session-chips" className="flex flex-wrap gap-2">
          {sessions.map((s: SessionState) => (
            <button
              key={s.id}
              type="button"
              data-testid={`session-chip-${s.id}`}
              aria-pressed={activeId === s.id}
              onClick={() => setSelectedId(s.id)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                activeId === s.id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-border hover:border-[var(--fg-faint)]"
              }`}
            >
              <StateDot state={s.state} />
              <span className="max-w-52 truncate font-mono text-xs">{s.subject}</span>
              <span className="text-xs text-[var(--fg-muted)]">
                {t("messages.sessions.rate", { rate: rateLabel(s.rate_msg_s) })}
              </span>
              <span className="text-xs text-[var(--fg-muted)]">
                {t("messages.sessions.total", { n: s.total })}
              </span>
              {s.dropped > 0 && (
                <Badge variant="destructive">
                  {t("messages.sessions.dropped", { n: s.dropped })}
                </Badge>
              )}
            </button>
          ))}
        </div>
      ) : (
        <p data-testid="sessions-empty" className="p-2 text-sm text-[var(--fg-muted)]">
          {t("messages.sessions.empty")}
        </p>
      )}

      {/* The selected session's virtualized message view */}
      {active && (
        <SessionView
          key={active.id}
          session={active}
          msgs={messages[active.id] ?? []}
          onPause={() => pause(active.id)}
          onResume={() => resume(active.id)}
          onClear={() => clear(active.id)}
          onClose={() => close(active.id)}
        />
      )}
    </div>
  );
}
