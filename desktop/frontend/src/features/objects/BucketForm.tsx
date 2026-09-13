import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import type { ObjBucketForm as ObjBucketFormWire } from "../../lib/bindings";
import {
  collectErrors,
  objBucketFormSchema,
  type ActionResult,
  type ObjBucketFormValues,
} from "./schema";
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

export type BucketFormMode = "create" | "edit";

export interface BucketFormProps {
  open: boolean;
  mode: BucketFormMode;
  /** detail.form (wire) prefill for edit; ignored for create. Read through a
   * ref at open time only — the poll replaces the detail object constantly
   * and must never clobber what the operator is typing. */
  initial?: ObjBucketFormWire | null;
  /** Called with parsed+validated values; returns the CallResult so
   * error_code=validation renders the server原文 inline. Toasts/refresh
   * belong to the caller (useObjects actions). */
  onSubmit: (values: ObjBucketFormValues) => Promise<ActionResult | null | undefined>;
  /** Close request: after a successful submit or any user dismiss. */
  onDone?: () => void;
}

interface Draft {
  name: string;
  description: string;
  maxBytes: string;
  replicas: string;
}

const emptyDraft = (): Draft => ({
  name: "",
  description: "",
  maxBytes: "",
  replicas: "1",
});

/** Input text → number; "" (empty = default) maps to the explicit 0. */
const parseNum = (s: string): number => {
  const t = s.trim();
  if (t === "") return 0;
  const n = Number(t);
  return Number.isNaN(n) ? Number.NaN : n;
};

const wireToDraft = (w: ObjBucketFormWire): Draft => ({
  name: w.name ?? "",
  description: w.description ?? "",
  maxBytes: w.max_bytes ? String(w.max_bytes) : "",
  replicas: w.replicas ? String(w.replicas) : "1",
});

const draftToValues = (d: Draft): ObjBucketFormValues => ({
  name: d.name.trim(),
  description: d.description,
  max_bytes: parseNum(d.maxBytes),
  replicas: parseNum(d.replicas),
});

/**
 * Object bucket create/edit dialog (spec §6.9). Validation mirrors the Go
 * ValidateObjBucketForm rules via zod; edit freezes the name (the server has
 * no bucket rename). Server validation errors render the 原文 inline and keep
 * the dialog open with the input intact.
 */
export function BucketForm({ open, mode, initial, onSubmit, onDone }: BucketFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  const [pending, setPending] = useState(false);

  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (!open) return;
    setDraft(mode === "edit" && initialRef.current ? wireToDraft(initialRef.current) : emptyDraft());
    setErrors({});
    setServerError("");
    setPending(false);
  }, [open, mode]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const handleSubmit = async () => {
    if (pending) return;
    const parsed = objBucketFormSchema.safeParse(draftToValues(draft));
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setServerError("");
    setPending(true); // spinner immediately — optimistic loading (GC 9/13)
    try {
      const res = await onSubmit(parsed.data);
      if (res && res.error_code) {
        // error_code=validation renders the 原文 inline; any other code is
        // toasted by the caller — either way the dialog stays open.
        if (res.error_code === "validation") setServerError(res.error || res.error_code);
        return;
      }
      onDone?.();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onDone?.();
      }}
    >
      <DialogContent data-testid="objects-bucket-form" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="objects-bucket-form-title">
            {t(mode === "edit" ? "objects.form.titleEdit" : "objects.form.titleCreate")}
          </DialogTitle>
        </DialogHeader>

        {serverError && (
          <div
            role="alert"
            data-testid="objects-bucket-form-server-error"
            className="rounded-md border border-[var(--danger-fg)] px-3 py-2 text-sm text-[var(--danger-fg)]"
          >
            {serverError}
          </div>
        )}

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="objects-bucket-form-name"
              label={t("objects.form.name")}
              hint={t("objects.form.nameHint")}
              error={errors.name ? t(errors.name) : undefined}
            >
              <Input
                id="objects-bucket-form-name"
                data-testid="objects-bucket-form-name"
                value={draft.name}
                disabled={mode === "edit"}
                aria-invalid={errors.name ? true : undefined}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field id="objects-bucket-form-description" label={t("objects.form.description")}>
              <Input
                id="objects-bucket-form-description"
                data-testid="objects-bucket-form-description"
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="objects-bucket-form-max-bytes"
              label={t("objects.form.maxBytes")}
              error={errors.max_bytes ? t(errors.max_bytes) : undefined}
            >
              <Input
                id="objects-bucket-form-max-bytes"
                data-testid="objects-bucket-form-max-bytes"
                inputMode="numeric"
                placeholder="-1"
                value={draft.maxBytes}
                onChange={(e) => patch({ maxBytes: e.target.value })}
              />
            </Field>
            <Field
              id="objects-bucket-form-replicas"
              label={t("objects.form.replicas")}
              error={errors.replicas ? t(errors.replicas) : undefined}
            >
              <Input
                id="objects-bucket-form-replicas"
                data-testid="objects-bucket-form-replicas"
                inputMode="numeric"
                className="w-20"
                value={draft.replicas}
                onChange={(e) => patch({ replicas: e.target.value })}
              />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-[var(--fg-muted)]">{t("objects.form.limitsHint")}</p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            data-testid="objects-bucket-form-cancel"
            disabled={pending}
            onClick={() => onDone?.()}
          >
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="objects-bucket-form-submit"
            disabled={pending}
            onClick={() => void handleSubmit()}
          >
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {t(pending ? "objects.form.submitting" : mode === "edit" ? "objects.form.submitEdit" : "objects.form.submitCreate")}
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
        <p role="alert" data-testid={`objects-bucket-form-error-${id.split("-").pop()}`} className="text-xs text-[var(--danger-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}
