import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import { fromBase64, toBase64 } from "../../lib/base64";
import type { KeyValueOut, PutKeyResult } from "../../lib/bindings";
import { utf8Length } from "../messages/schema";
import {
  collectErrors,
  keyEditorSchema,
  type KeyMode,
} from "./schema";
import type { PutKeyArgs } from "./useKv";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface KeyEditorProps {
  open: boolean;
  bucket: string;
  /** Existing key prefill (key name + revision + value); null = fresh key. */
  initial: KeyValueOut | null;
  /** Performs the PutKey call (toasts/refresh belong to the hook); resolves
   * with the wire result so the conflict banners can react to it. */
  onSubmit: (args: PutKeyArgs) => Promise<PutKeyResult>;
  /** Close request: after a successful submit or any user dismiss. */
  onDone?: () => void;
}

const MODES: KeyMode[] = ["put", "create", "update"];

/**
 * Key editor dialog (spec §6.8): mode put | create | update with the CAS
 * expected-revision locked display in update mode, a monospace textarea for
 * the text value (the >8 MiB cap blocks inline; a non-UTF-8 current value
 * shows a read-only notice pointing at the key detail's PayloadView instead
 * of pre-filling mojibake), and the two conflict paths:
 * - create conflict → inline banner「键已存在……」+ a one-click「改用 put」
 *   switch; the draft (textarea) is preserved across both.
 * - update conflict → inline「期望修订版 X 与当前 Y 不符」+ the displayed
 *   expected revision auto-refreshes to Y while the draft stays untouched.
 */
export function KeyEditor({ open, bucket, initial, onSubmit, onDone }: KeyEditorProps) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<KeyMode>("put");
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [binary, setBinary] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // conflict: { expected, current } for the update banner; create conflicts
  // render the existence banner (expected/current are not meaningful there).
  const [conflict, setConflict] = useState<{
    kind: "create" | "update";
    expected: number;
    current: number;
  } | null>(null);
  const [serverError, setServerError] = useState("");
  const [pending, setPending] = useState(false);

  const initialRef = useRef(initial);
  initialRef.current = initial;

  // Prefill at open time only (the poll replaces the value object constantly
  // and must never clobber the operator's draft).
  useEffect(() => {
    if (!open) return;
    const src = initialRef.current;
    setKey(src?.key ?? "");
    if (src && !src.not_found && src.payload_b64) {
      setBinary(!src.is_utf8);
      setValue(src.is_utf8 ? fromBase64(src.payload_b64) : "");
    } else {
      setBinary(false);
      setValue("");
    }
    setMode("put");
    setExpectedRevision(src?.revision ?? 0);
    setErrors({});
    setConflict(null);
    setServerError("");
    setPending(false);
  }, [open]);

  const patchValue = (v: string) => {
    setValue(v);
    // Editing the draft clears the stale conflict state — a new submit is a
    // new attempt (the revision display itself is kept).
    setConflict(null);
    setServerError("");
  };

  const handleSubmit = async () => {
    if (pending) return;
    const parsed = keyEditorSchema.safeParse({
      key,
      mode,
      value,
      expected_revision: expectedRevision,
    });
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setConflict(null);
    setServerError("");
    setPending(true); // spinner immediately — optimistic loading (GC 9/13)
    try {
      const usedExpected = expectedRevision;
      const res = await onSubmit({
        bucket,
        key: parsed.data.key,
        payloadB64: toBase64(parsed.data.value),
        mode: parsed.data.mode,
        expectedRevision: parsed.data.expected_revision,
      });
      if (res?.error_code === "conflict") {
        if (parsed.data.mode === "create") {
          // §6.8 异常 1: key exists → banner + one-click mode switch; the
          // draft state is untouched.
          setConflict({ kind: "create", expected: usedExpected, current: res.current_revision });
        } else if (parsed.data.mode === "update") {
          // §6.8 异常 2: CAS mismatch → banner with X vs Y, the displayed
          // expected revision auto-refreshes to Y; the textarea (draft) is
          // NOT touched — only the revision display changes.
          setConflict({
            kind: "update",
            expected: usedExpected,
            current: res.current_revision,
          });
          setExpectedRevision(res.current_revision);
        } else {
          setServerError(res.error || res.error_code);
        }
        return;
      }
      if (res?.error_code) {
        // Validation/other failures: the hook already toasted the server原文;
        // keep the dialog open with the input intact.
        setServerError(res.error || res.error_code);
        return;
      }
      onDone?.();
    } finally {
      setPending(false);
    }
  };

  const sizeBytes = utf8Length(value);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onDone?.();
      }}
    >
      <DialogContent data-testid="kv-editor" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle data-testid="kv-editor-title">
            {t(initial ? "kv.editor.titleExisting" : "kv.editor.titleNew", { bucket })}
          </DialogTitle>
        </DialogHeader>

        {/* §6.8 异常 2: update CAS conflict banner */}
        {conflict?.kind === "update" && (
          <div
            role="alert"
            data-testid="kv-editor-conflict"
            className="rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]"
          >
            {t("kv.editor.conflictUpdate", {
              expected: conflict.expected,
              current: conflict.current,
            })}
          </div>
        )}

        {/* §6.8 异常 1: create conflict banner + one-click switch to put */}
        {conflict?.kind === "create" && (
          <div
            role="alert"
            data-testid="kv-editor-conflict"
            className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]"
          >
            <span>{t("kv.editor.conflictCreate")}</span>
            <Button
              size="sm"
              variant="outline"
              data-testid="kv-editor-switch-put"
              className="ml-auto"
              onClick={() => {
                setMode("put");
                setConflict(null);
              }}
            >
              {t("kv.editor.switchPut")}
            </Button>
          </div>
        )}

        {serverError && (
          <div
            role="alert"
            data-testid="kv-editor-server-error"
            className="rounded-md border border-[var(--danger-fg)] px-3 py-2 text-sm text-[var(--danger-fg)]"
          >
            {serverError}
          </div>
        )}

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="kv-editor-key" label={t("kv.editor.key")} error={errors.key ? t(errors.key) : undefined}>
              <Input
                id="kv-editor-key"
                data-testid="kv-editor-key"
                value={key}
                disabled={Boolean(initial)} // editing an existing key: the name is frozen
                aria-invalid={errors.key ? true : undefined}
                className="font-mono"
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <Field id="kv-editor-mode" label={t("kv.editor.mode")} error={errors.mode ? t(errors.mode) : undefined}>
              <select
                id="kv-editor-mode"
                data-testid="kv-editor-mode"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as KeyMode);
                  setConflict(null);
                  setServerError("");
                }}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`kv.editor.mode_${m}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* CAS display: update shows the expected revision locked; it is
              auto-refreshed to the server's current revision on conflict. */}
          {mode === "update" && (
            <div
              data-testid="kv-editor-expected"
              className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm"
            >
              <span className="text-[var(--fg-muted)]">{t("kv.editor.expected")}</span>
              <span className="font-mono tabular-nums">#{expectedRevision}</span>
              <span className="text-xs text-[var(--fg-faint)]">{t("kv.editor.expectedHint")}</span>
            </div>
          )}

          {binary && (
            <div
              data-testid="kv-editor-binary-note"
              className="rounded-md border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]"
            >
              {t("kv.editor.binary")}
            </div>
          )}

          <Field
            id="kv-editor-value"
            label={t("kv.editor.value")}
            hint={t("kv.editor.valueHint", { size: sizeBytes })}
            error={errors.value ? t(errors.value) : undefined}
          >
            <textarea
              id="kv-editor-value"
              data-testid="kv-editor-value"
              rows={8}
              spellCheck={false}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
              aria-invalid={errors.value ? true : undefined}
              value={value}
              onChange={(e) => patchValue(e.target.value)}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            data-testid="kv-editor-cancel"
            disabled={pending}
            onClick={() => onDone?.()}
          >
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="kv-editor-submit"
            disabled={pending}
            onClick={() => void handleSubmit()}
          >
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {t(pending ? "kv.editor.submitting" : "kv.editor.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Label + control + hint + inline validation error (zod), the form's row. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label htmlFor={id}>{label}</Label>}
      {children}
      {hint && <p className="text-xs text-[var(--fg-muted)]">{hint}</p>}
      {error && (
        <p role="alert" data-testid={`kv-editor-error-${id.replace("kv-editor-", "")}`} className="text-xs text-[var(--danger-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}
