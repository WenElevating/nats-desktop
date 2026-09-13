import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface DangerOpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Op id for tests/anchors, e.g. "meta_step_down" | "stream_balance". */
  op: string;
  /** Dialog title (usually the op's i18n label). */
  title: string;
  /** Impact explanation lines (re-election / replica-migration duration…). */
  impactLines: string[];
  /** The exact name that must be retyped before confirm enables — L2 is
   * ALWAYS enforced here regardless of the confirm-policy setting (M4
   * precedent: confirmNameMatch is never policy-gated). */
  expectedName: string;
  /** An operation is running: confirm/cancel show a spinner and disable, and
   * Esc / overlay clicks / cancel cannot close mid-flight (Global 6). */
  inFlight: boolean;
  /** Optional extra control slot above the name input (e.g. a peer picker). */
  extra?: ReactNode;
  /** Called once per confirmed click; the parent owns the dialog lifetime. */
  onConfirm: () => void;
}

/**
 * Level-2 confirmation dialog for cluster danger ops (spec §6.11 / Task 12):
 * the operator must retype the exact target name — a mismatch keeps the
 * confirm button disabled and shows the common.nameMismatch hint while the
 * dialog stays open — and reads the impact list (election/migration duration
 * wording, data-loss warnings) before executing. Esc, cancel and the overlay
 * close it while idle; once `inFlight` they are ignored so the result toast
 * always lands after the dialog is demonstrably finished.
 */
export function DangerOpDialog({
  open,
  onOpenChange,
  op,
  title,
  impactLines,
  expectedName,
  inFlight,
  extra,
  onConfirm,
}: DangerOpDialogProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");

  // Each opening starts from an empty input: a stale match from a previous
  // run of the same dialog must never enable confirm silently.
  useEffect(() => {
    if (open) setInput("");
  }, [open, op]);

  const matched = input === expectedName && expectedName !== "";

  // Close requests (Esc / overlay / cancel / X) are ignored mid-flight.
  const requestClose = (next: boolean) => {
    if (!next && inFlight) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        data-testid="danger-op-dialog"
        data-op={op}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("common.nameMatchTitle", { name: expectedName })}
          </DialogDescription>
        </DialogHeader>

        {/* Impact explanation list (re-election / replica migration …). */}
        <div data-testid="danger-op-impact" className="flex flex-col gap-1">
          <p className="text-xs font-medium text-[var(--fg-muted)]">
            {t("clusterOps.impactTitle")}
          </p>
          <ul className="ml-4 list-disc text-xs text-[var(--fg-muted)]">
            {impactLines.map((line, i) => (
              <li key={i} className="min-w-0 break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>

        {extra}

        <div className="flex flex-col gap-1">
          <Input
            data-testid="danger-op-input"
            aria-label={t("common.nameMatchTitle", { name: expectedName })}
            value={input}
            placeholder={expectedName}
            disabled={inFlight}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matched && !inFlight) onConfirm();
            }}
            className="h-8 font-mono text-sm"
          />
          {!matched && (
            <p
              data-testid="danger-op-mismatch"
              className="text-xs text-[var(--danger-fg)]"
            >
              {t("common.nameMismatch")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            data-testid="danger-op-cancel"
            disabled={inFlight}
            onClick={() => requestClose(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            data-testid="danger-op-confirm"
            disabled={!matched || inFlight}
            onClick={onConfirm}
          >
            {inFlight && (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            )}
            {t(inFlight ? "clusterOps.inFlight" : "clusterOps.execute")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DangerOpDialog;
