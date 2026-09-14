import { useCallback, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "../../app/i18n";
import { useConnState } from "../../app/connstate";
import type { ClusterOpResult, MonitorSnapshot } from "../../lib/bindings";
import {
  MetaPeerRemove,
  MetaStepDown,
  StreamBalance,
  StreamPeerRemove,
  StreamStepDown,
} from "../../lib/bindings";
import { DangerOpDialog } from "./DangerOpDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Danger zone (spec §6.11 / Task 12): the red-separated cluster-operations
// area. Every op is level-2 — the DangerOpDialog enforces an exact name match
// unconditionally (confirm-policy settings never downgrade L2, M4 precedent).
// The Go side single-flights ops (Global 6): a second op while one runs comes
// back with error_code "conflict", toasted as "operation in progress"; other
// failures toast the server 原文.
// ---------------------------------------------------------------------------

type OpKey =
  | "meta_step_down"
  | "stream_step_down"
  | "stream_balance"
  | "meta_peer_remove"
  | "stream_peer_remove";

/** Impact-line i18n keys per op (rendered through t() in the dialog). */
const IMPACT: Record<OpKey, string[]> = {
  meta_step_down: ["clusterOps.impact.metaStepDown.a", "clusterOps.impact.metaStepDown.b"],
  stream_step_down: ["clusterOps.impact.streamStepDown.a", "clusterOps.impact.streamStepDown.b"],
  stream_balance: ["clusterOps.impact.balance.a", "clusterOps.impact.balance.b"],
  meta_peer_remove: [
    "clusterOps.impact.metaPeerRemove.a",
    "clusterOps.impact.metaPeerRemove.b",
    "clusterOps.impact.metaPeerRemove.c",
  ],
  stream_peer_remove: [
    "clusterOps.impact.streamPeerRemove.a",
    "clusterOps.impact.streamPeerRemove.b",
  ],
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const elapsedSec = (res: ClusterOpResult): string => `${(res.elapsed_ms / 1000).toFixed(1)}s`;

export interface DangerZoneProps {
  /** Latest monitoring snapshot — the current meta leader name (the Meta
   * step-down L2 target) is read from it. */
  snapshot: MonitorSnapshot | null;
}

interface DialogSpec {
  op: OpKey;
  title: string;
  expectedName: string;
}

/**
 * DangerZone (spec §6.11): four op cards — meta step-down (target = the
 * current meta leader, shown from the snapshot), stream step-down, stream
 * balance (targets typed on the card, retyped exactly in the dialog), and
 * peer-remove with a meta/stream scope toggle (the meta scope carries the
 * natscli parity warnings: full cluster restart to return, R1 data loss, R1
 * consumer state reset). Results toast old→new leader / balanced N / elapsed.
 */
export function DangerZone({ snapshot }: DangerZoneProps) {
  const { t } = useTranslation();
  const conn = useConnState();
  const connected = conn.state === "connected";

  const metaLeader =
    (snapshot?.servers ?? []).find((r) => r.online && r.js_role === "meta_leader")?.name ?? "";

  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [pending, setPending] = useState<OpKey | null>(null);

  // Card-local targets.
  const [streamStepDownInput, setStreamStepDownInput] = useState("");
  const [balanceInput, setBalanceInput] = useState("");
  const [peerScope, setPeerScope] = useState<"meta" | "stream">("meta");
  const [peerStreamInput, setPeerStreamInput] = useState("");
  const [peerInput, setPeerInput] = useState("");

  /** Runs one op with the dialog left open (spinner + disabled) until the
   * result toast lands, then closes it (Global 6: feedback stays visible). */
  const runOp = useCallback(
    async (op: OpKey, call: () => Promise<ClusterOpResult>, done: (res: ClusterOpResult) => string) => {
      setPending(op);
      try {
        const res = await call();
        if (!res || res.error_code) {
          if (res?.error_code === "conflict") {
            toast.error(t("clusterOps.conflict"));
          } else {
            toast.error(t("clusterOps.failed", { error: res?.error || res?.error_code || "" }));
          }
        } else {
          toast.success(done(res));
        }
      } catch (err) {
        toast.error(t("clusterOps.failed", { error: errText(err) }));
      } finally {
        setPending(null);
        setDialog(null);
      }
    },
    [t],
  );

  /** Step-down/balance success toast: old→new leader (or balanced N) + elapsed,
   * with the server note appended when the new leader was not observed. */
  const noteSuffix = (res: ClusterOpResult): string => (res.note ? ` · ${res.note}` : "");

  const openDialog = (op: OpKey, expectedName: string) =>
    setDialog({
      op,
      title: t(
        op === "meta_step_down"
          ? "clusterOps.metaStepDown"
          : op === "stream_step_down"
            ? "clusterOps.streamStepDown"
            : op === "stream_balance"
              ? "clusterOps.balance"
              : "clusterOps.peerRemove",
      ),
      expectedName,
    });

  const onConfirm = () => {
    if (!dialog || pending) return;
    switch (dialog.op) {
      case "meta_step_down":
        void runOp(
          "meta_step_down",
          MetaStepDown,
          (res) =>
            t("clusterOps.done.stepDown", {
              old: res.old_leader,
              next: res.new_leader || "—",
              elapsed: elapsedSec(res),
            }) + noteSuffix(res),
        );
        break;
      case "stream_step_down":
        void runOp(
          "stream_step_down",
          () => StreamStepDown(streamStepDownInput.trim()),
          (res) =>
            t("clusterOps.done.stepDown", {
              old: res.old_leader,
              next: res.new_leader || "—",
              elapsed: elapsedSec(res),
            }) + noteSuffix(res),
        );
        break;
      case "stream_balance":
        void runOp(
          "stream_balance",
          () => StreamBalance(balanceInput.trim()),
          (res) => t("clusterOps.done.balance", { count: res.streams_balanced, elapsed: elapsedSec(res) }),
        );
        break;
      case "meta_peer_remove":
        void runOp(
          "meta_peer_remove",
          () => MetaPeerRemove(peerInput.trim()),
          (res) =>
            t("clusterOps.done.peerRemove", { peer: peerInput.trim(), elapsed: elapsedSec(res) }) +
            noteSuffix(res),
        );
        break;
      case "stream_peer_remove":
        void runOp(
          "stream_peer_remove",
          () => StreamPeerRemove(peerStreamInput.trim(), peerInput.trim()),
          (res) =>
            t("clusterOps.done.peerRemove", { peer: peerInput.trim(), elapsed: elapsedSec(res) }) +
            noteSuffix(res),
        );
        break;
    }
  };

  const peerTargetValid =
    peerInput.trim() !== "" && (peerScope === "meta" || peerStreamInput.trim() !== "");

  const cardCls =
    "flex min-w-0 flex-col gap-1.5 rounded-md border border-[var(--danger)] bg-background p-2.5";
  const inputCls = "h-7 font-mono text-xs";

  return (
    <div
      data-testid="danger-zone"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto rounded-md border border-[var(--danger)] p-3"
    >
      {/* Red-separated header (§6.11: visually distinct danger area). */}
      <div className="flex shrink-0 items-center gap-2">
        <TriangleAlert size={15} strokeWidth={1.75} className="text-[var(--danger-fg)]" aria-hidden="true" />
        <h3 className="text-sm font-medium text-[var(--danger-fg)]">{t("clusterOps.title")}</h3>
        <span className="min-w-0 truncate text-xs text-[var(--fg-muted)]">
          {t("clusterOps.subtitle")}
        </span>
      </div>

      <div className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2">
        {/* Meta leader step-down — the L2 target IS the current meta leader. */}
        <div data-testid="danger-card-meta-step-down" className={cardCls}>
          <p className="text-xs font-medium">{t("clusterOps.metaStepDown")}</p>
          <p className="text-xs text-[var(--fg-muted)]">{t("clusterOps.metaStepDown.desc")}</p>
          <p className="text-xs text-[var(--fg-muted)]">
            {t("clusterOps.currentLeader")}:{" "}
            <span data-testid="danger-meta-leader" className="font-mono">
              {metaLeader || "—"}
            </span>
          </p>
          <Button
            size="sm"
            variant="destructive"
            data-testid="danger-btn-meta-step-down"
            disabled={!connected || metaLeader === ""}
            onClick={() => openDialog("meta_step_down", metaLeader)}
            className="mt-auto h-7 self-start px-2 text-xs"
          >
            {t("clusterOps.metaStepDown")}
          </Button>
        </div>

        {/* Stream leader step-down */}
        <div data-testid="danger-card-stream-step-down" className={cardCls}>
          <p className="text-xs font-medium">{t("clusterOps.streamStepDown")}</p>
          <p className="text-xs text-[var(--fg-muted)]">{t("clusterOps.streamStepDown.desc")}</p>
          <Input
            data-testid="danger-stream-stepdown-input"
            aria-label={t("clusterOps.streamName")}
            placeholder={t("clusterOps.streamName")}
            value={streamStepDownInput}
            disabled={!connected}
            onChange={(e) => setStreamStepDownInput(e.target.value)}
            className={inputCls}
          />
          <Button
            size="sm"
            variant="destructive"
            data-testid="danger-btn-stream-step-down"
            disabled={!connected || streamStepDownInput.trim() === ""}
            title={streamStepDownInput.trim() === "" ? t("clusterOps.needStream") : undefined}
            onClick={() => openDialog("stream_step_down", streamStepDownInput.trim())}
            className="mt-auto h-7 self-start px-2 text-xs"
          >
            {t("clusterOps.streamStepDown")}
          </Button>
        </div>

        {/* Stream leader balance */}
        <div data-testid="danger-card-stream-balance" className={cardCls}>
          <p className="text-xs font-medium">{t("clusterOps.balance")}</p>
          <p className="text-xs text-[var(--fg-muted)]">{t("clusterOps.balance.desc")}</p>
          <Input
            data-testid="danger-balance-input"
            aria-label={t("clusterOps.streamName")}
            placeholder={t("clusterOps.streamName")}
            value={balanceInput}
            disabled={!connected}
            onChange={(e) => setBalanceInput(e.target.value)}
            className={inputCls}
          />
          <Button
            size="sm"
            variant="destructive"
            data-testid="danger-btn-stream-balance"
            disabled={!connected || balanceInput.trim() === ""}
            title={balanceInput.trim() === "" ? t("clusterOps.needStream") : undefined}
            onClick={() => openDialog("stream_balance", balanceInput.trim())}
            className="mt-auto h-7 self-start px-2 text-xs"
          >
            {t("clusterOps.balance")}
          </Button>
        </div>

        {/* Peer remove (meta group / stream RAFT group) */}
        <div data-testid="danger-card-peer-remove" className={cardCls}>
          <p className="text-xs font-medium">{t("clusterOps.peerRemove")}</p>
          <p className="text-xs text-[var(--fg-muted)]">{t("clusterOps.peerRemove.desc")}</p>
          <div
            role="group"
            aria-label={t("clusterOps.scopeTitle")}
            className="flex items-center gap-1"
          >
            {(["meta", "stream"] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                data-testid={`danger-peer-scope-${sc}`}
                aria-pressed={peerScope === sc}
                onClick={() => setPeerScope(sc)}
                className={`rounded-md px-2 py-0.5 text-xs ${
                  peerScope === sc
                    ? "bg-[var(--danger-soft)] font-medium text-[var(--danger-fg)]"
                    : "text-[var(--fg-muted)] hover:text-foreground"
                }`}
              >
                {t(sc === "meta" ? "clusterOps.scope.meta" : "clusterOps.scope.stream")}
              </button>
            ))}
          </div>
          {peerScope === "stream" && (
            <Input
              data-testid="danger-peer-stream-input"
              aria-label={t("clusterOps.streamName")}
              placeholder={t("clusterOps.streamName")}
              value={peerStreamInput}
              disabled={!connected}
              onChange={(e) => setPeerStreamInput(e.target.value)}
              className={inputCls}
            />
          )}
          <Input
            data-testid="danger-peer-input"
            aria-label={t("clusterOps.peerName")}
            placeholder={t("clusterOps.peerName")}
            value={peerInput}
            disabled={!connected}
            onChange={(e) => setPeerInput(e.target.value)}
            className={inputCls}
          />
          <Button
            size="sm"
            variant="destructive"
            data-testid="danger-btn-peer-remove"
            disabled={!connected || !peerTargetValid}
            onClick={() =>
              openDialog(
                peerScope === "meta" ? "meta_peer_remove" : "stream_peer_remove",
                peerInput.trim(),
              )
            }
            className="mt-auto h-7 self-start px-2 text-xs"
          >
            {t("clusterOps.peerRemove")}
          </Button>
        </div>
      </div>

      {dialog && (
        <DangerOpDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          op={dialog.op}
          title={dialog.title}
          impactLines={IMPACT[dialog.op].map((k) => t(k))}
          expectedName={dialog.expectedName}
          inFlight={pending !== null}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
}

export default DangerZone;
