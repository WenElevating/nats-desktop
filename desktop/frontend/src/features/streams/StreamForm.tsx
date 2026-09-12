import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import type { StreamForm as StreamFormWire } from "../../lib/bindings";
import { streamFormSchema, type ActionResult, type StreamFormValues } from "./schema";
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

export type StreamFormMode = "create" | "edit" | "copy";

export interface StreamFormProps {
  open: boolean;
  mode: StreamFormMode;
  /** detail.form (wire) prefill for edit/copy; ignored for create. */
  initial?: StreamFormWire | null;
  /** Called with parsed+validated values (create mode of a copy submits via
   * CreateStream; edit via UpdateStream — the caller decides). Returns the
   * CallResult so error_code=validation can render the server原文 inline;
   * toasts/refresh belong to the caller (useStreams actions). */
  onSubmit: (
    values: StreamFormValues,
  ) => Promise<ActionResult | null | undefined> | ActionResult | null | undefined;
  /** Close request: after a successful submit or any user dismiss. */
  onDone?: () => void;
}

// ---- draft (the editable stringy shape of the form) ----

interface SourceDraft {
  name: string;
  filter: string;
  startSeq: string;
}

interface Draft {
  name: string;
  description: string;
  subjectsText: string;
  storage: string;
  retention: string;
  maxMsgs: string;
  maxBytes: string;
  maxAge: string;
  maxPer: string;
  replicas: string;
  cluster: string;
  tagsText: string;
  mirrorOn: boolean;
  mirrorName: string;
  mirrorFilter: string;
  mirrorStartSeq: string;
  sources: SourceDraft[];
}

const emptyDraft = (): Draft => ({
  name: "",
  description: "",
  subjectsText: "",
  storage: "file",
  retention: "limits",
  maxMsgs: "",
  maxBytes: "",
  maxAge: "",
  maxPer: "",
  replicas: "1",
  cluster: "",
  tagsText: "",
  mirrorOn: false,
  mirrorName: "",
  mirrorFilter: "",
  mirrorStartSeq: "",
  sources: [],
});

/** Input text → number; "" (empty = default) maps to the explicit 0. */
const parseNum = (s: string): number => {
  const t = s.trim();
  if (t === "") return 0;
  const n = Number(t);
  return Number.isNaN(n) ? Number.NaN : n;
};

const numToInput = (n: number | null | undefined): string =>
  n === null || n === undefined ? "" : String(n);

/** Draft → schema values. Subjects are textarea lines (trimmed, blanks
 * dropped); placement tags are comma-separated; enums come from the selects. */
const draftToValues = (d: Draft): StreamFormValues => ({
  name: d.name,
  description: d.description,
  subjects: d.subjectsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== ""),
  storage: d.storage as StreamFormValues["storage"],
  retention: d.retention as StreamFormValues["retention"],
  max_msgs: parseNum(d.maxMsgs),
  max_bytes: parseNum(d.maxBytes),
  max_age_seconds: parseNum(d.maxAge),
  max_msgs_per_subject: parseNum(d.maxPer),
  replicas: parseNum(d.replicas),
  placement_cluster: d.cluster.trim(),
  placement_tags: d.tagsText
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== ""),
  mirror: d.mirrorOn
    ? {
        name: d.mirrorName.trim(),
        filter_subject: d.mirrorFilter.trim(),
        opt_start_seq: parseNum(d.mirrorStartSeq),
      }
    : null,
  sources: d.sources.map((s) => ({
    name: s.name.trim(),
    filter_subject: s.filter.trim(),
    opt_start_seq: parseNum(s.startSeq),
  })),
});

/** Wire (detail.form) → draft, for the edit/copy prefill. */
const wireToDraft = (w: StreamFormWire): Draft => ({
  name: w.name ?? "",
  description: w.description ?? "",
  subjectsText: (w.subjects ?? []).join("\n"),
  storage: w.storage || "file",
  retention: w.retention || "limits",
  maxMsgs: numToInput(w.max_msgs),
  maxBytes: numToInput(w.max_bytes),
  maxAge: numToInput(w.max_age_seconds),
  maxPer: numToInput(w.max_msgs_per_subject),
  replicas: numToInput(w.replicas) || "1",
  cluster: w.placement_cluster ?? "",
  tagsText: (w.placement_tags ?? []).join(", "),
  mirrorOn: w.mirror != null,
  mirrorName: w.mirror?.name ?? "",
  mirrorFilter: w.mirror?.filter_subject ?? "",
  mirrorStartSeq: numToInput(w.mirror?.opt_start_seq),
  sources: (w.sources ?? []).map((s) => ({
    name: s.name,
    filter: s.filter_subject,
    startSeq: numToInput(s.opt_start_seq),
  })),
});

/** First zod issue message (an i18n key) per top-level field. */
const collectErrors = (
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
};

export function StreamForm({ open, mode, initial, onSubmit, onDone }: StreamFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  const [pending, setPending] = useState(false);
  const [showPlacement, setShowPlacement] = useState(false);
  const [showSources, setShowSources] = useState(false);

  // Prefill reads `initial` through a ref at open/mode-change time only — the
  // 5s detail poll replaces the detail object constantly and must never
  // clobber what the operator is typing.
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (!open) return;
    const src = initialRef.current;
    if (mode !== "create" && src) {
      // Copy prefills everything EXCEPT the name (the operator must choose a
      // fresh one); edit keeps it (frozen input below).
      setDraft({ ...wireToDraft(src), ...(mode === "copy" ? { name: "" } : {}) });
      // These sections start collapsed; open them when they carry data.
      setShowSources(Boolean(src.mirror) || (src.sources?.length ?? 0) > 0);
      setShowPlacement(Boolean(src.placement_cluster) || (src.placement_tags?.length ?? 0) > 0);
    } else {
      setDraft(emptyDraft());
      setShowPlacement(false);
      setShowSources(false);
    }
    setErrors({});
    setServerError("");
    setPending(false);
  }, [open, mode]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const addSource = () =>
    setDraft((d) => ({
      ...d,
      sources: [...d.sources, { name: "", filter: "", startSeq: "" }],
    }));

  const patchSource = (i: number, p: Partial<SourceDraft>) =>
    setDraft((d) => ({
      ...d,
      sources: d.sources.map((s, j) => (j === i ? { ...s, ...p } : s)),
    }));

  const removeSource = (i: number) =>
    setDraft((d) => ({ ...d, sources: d.sources.filter((_, j) => j !== i) }));

  const handleSubmit = async () => {
    if (pending) return;
    const parsed = streamFormSchema.safeParse(draftToValues(draft));
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
        // Server rejected: error_code=validation renders the 原文 inline at
        // the top of the form; any other code is toasted by the caller —
        // either way the dialog stays open with the input intact.
        if (res.error_code === "validation") setServerError(res.error || res.error_code);
        return;
      }
      onDone?.();
    } finally {
      setPending(false);
    }
  };

  const titleKey =
    mode === "edit" ? "streams.form.titleEdit" : mode === "copy" ? "streams.form.titleCopy" : "streams.form.titleCreate";
  const submitKey =
    mode === "edit" ? "streams.form.submitEdit" : mode === "copy" ? "streams.form.submitCopy" : "streams.form.submitCreate";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onDone?.();
      }}
    >
      <DialogContent
        data-testid="stream-form"
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle data-testid="stream-form-title">{t(titleKey)}</DialogTitle>
        </DialogHeader>

        {serverError && (
          <div
            role="alert"
            data-testid="stream-form-server-error"
            className="rounded-md border border-[var(--danger-fg)] px-3 py-2 text-sm text-[var(--danger-fg)]"
          >
            {serverError}
          </div>
        )}

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="stream-form-name"
              label={t("streams.form.name")}
              hint={t("streams.form.nameHint")}
              error={errors.name ? t(errors.name) : undefined}
              errorKey="name"
            >
              {/* Edit renames would be "create as new" on the server, so the
                  name is frozen in edit mode (copy mode needs it empty). */}
              <Input
                id="stream-form-name"
                data-testid="stream-form-name"
                value={draft.name}
                disabled={mode === "edit"}
                aria-invalid={errors.name ? true : undefined}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field id="stream-form-description" label={t("streams.form.description")}>
              <Input
                id="stream-form-description"
                data-testid="stream-form-description"
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </div>

          <Field
            id="stream-form-subjects"
            label={t("streams.form.subjects")}
            hint={t("streams.form.subjectsHint")}
            error={errors.subjects ? t(errors.subjects) : undefined}
            errorKey="subjects"
          >
            <textarea
              id="stream-form-subjects"
              data-testid="stream-form-subjects"
              rows={3}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
              aria-invalid={errors.subjects ? true : undefined}
              placeholder={"orders.>\nshipping.*"}
              value={draft.subjectsText}
              onChange={(e) => patch({ subjectsText: e.target.value })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="stream-form-storage"
              label={t("streams.form.storage")}
              error={errors.storage ? t(errors.storage) : undefined}
              errorKey="storage"
            >
              <select
                id="stream-form-storage"
                data-testid="stream-form-storage"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={draft.storage}
                onChange={(e) => patch({ storage: e.target.value })}
              >
                <option value="file">{t("streams.form.file")}</option>
                <option value="memory">{t("streams.form.memory")}</option>
              </select>
            </Field>
            <Field
              id="stream-form-retention"
              label={t("streams.form.retention")}
              error={errors.retention ? t(errors.retention) : undefined}
              errorKey="retention"
            >
              <select
                id="stream-form-retention"
                data-testid="stream-form-retention"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={draft.retention}
                onChange={(e) => patch({ retention: e.target.value })}
              >
                <option value="limits">{t("streams.form.limits")}</option>
                <option value="interest">{t("streams.form.interest")}</option>
                <option value="workqueue">{t("streams.form.workqueue")}</option>
              </select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <Field
              id="stream-form-max-msgs"
              label={t("streams.form.maxMsgs")}
              error={errors.max_msgs ? t(errors.max_msgs) : undefined}
              errorKey="max_msgs"
            >
              <Input
                id="stream-form-max-msgs"
                data-testid="stream-form-max-msgs"
                inputMode="numeric"
                placeholder="-1"
                value={draft.maxMsgs}
                onChange={(e) => patch({ maxMsgs: e.target.value })}
              />
            </Field>
            <Field
              id="stream-form-max-bytes"
              label={t("streams.form.maxBytes")}
              error={errors.max_bytes ? t(errors.max_bytes) : undefined}
              errorKey="max_bytes"
            >
              <Input
                id="stream-form-max-bytes"
                data-testid="stream-form-max-bytes"
                inputMode="numeric"
                placeholder="-1"
                value={draft.maxBytes}
                onChange={(e) => patch({ maxBytes: e.target.value })}
              />
            </Field>
            <Field
              id="stream-form-max-age"
              label={t("streams.form.maxAge")}
              error={errors.max_age_seconds ? t(errors.max_age_seconds) : undefined}
              errorKey="max_age_seconds"
            >
              <Input
                id="stream-form-max-age"
                data-testid="stream-form-max-age"
                inputMode="numeric"
                placeholder="0"
                value={draft.maxAge}
                onChange={(e) => patch({ maxAge: e.target.value })}
              />
            </Field>
            <Field
              id="stream-form-max-per"
              label={t("streams.form.maxPerSubject")}
              error={errors.max_msgs_per_subject ? t(errors.max_msgs_per_subject) : undefined}
              errorKey="max_msgs_per_subject"
            >
              <Input
                id="stream-form-max-per"
                data-testid="stream-form-max-per"
                inputMode="numeric"
                placeholder="-1"
                value={draft.maxPer}
                onChange={(e) => patch({ maxPer: e.target.value })}
              />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-[var(--fg-muted)]">{t("streams.form.limitsHint")}</p>

          <div className="grid gap-4 sm:grid-cols-[1fr_2fr] sm:items-center">
            <Field
              id="stream-form-replicas"
              label={t("streams.form.replicas")}
              error={errors.replicas ? t(errors.replicas) : undefined}
              errorKey="replicas"
            >
              <Input
                id="stream-form-replicas"
                data-testid="stream-form-replicas"
                inputMode="numeric"
                className="w-20"
                value={draft.replicas}
                onChange={(e) => patch({ replicas: e.target.value })}
              />
            </Field>
          </div>

          {/* Collapsible: placement */}
          <section className="rounded-md border border-border">
            <button
              type="button"
              data-testid="stream-form-toggle-placement"
              aria-expanded={showPlacement}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
              onClick={() => setShowPlacement((v) => !v)}
            >
              {t("streams.form.sectionPlacement")}
              <span aria-hidden="true">{showPlacement ? "−" : "+"}</span>
            </button>
            {showPlacement && (
              <div className="grid gap-3 border-t border-border px-3 py-3 sm:grid-cols-2">
                <Field id="stream-form-cluster" label={t("streams.form.cluster")}>
                  <Input
                    id="stream-form-cluster"
                    data-testid="stream-form-cluster"
                    value={draft.cluster}
                    onChange={(e) => patch({ cluster: e.target.value })}
                  />
                </Field>
                <Field id="stream-form-tags" label={t("streams.form.tags")}>
                  <Input
                    id="stream-form-tags"
                    data-testid="stream-form-tags"
                    value={draft.tagsText}
                    onChange={(e) => patch({ tagsText: e.target.value })}
                  />
                </Field>
              </div>
            )}
          </section>

          {/* Collapsible: mirror & sources */}
          <section className="rounded-md border border-border">
            <button
              type="button"
              data-testid="stream-form-toggle-sources"
              aria-expanded={showSources}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
              onClick={() => setShowSources((v) => !v)}
            >
              {t("streams.form.sectionSources")}
              <span aria-hidden="true">{showSources ? "−" : "+"}</span>
            </button>
            {showSources && (
              <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="stream-form-mirror-on"
                    checked={draft.mirrorOn}
                    onChange={(e) => patch({ mirrorOn: e.target.checked })}
                  />
                  {t("streams.form.mirrorOn")}
                </label>
                {draft.mirrorOn && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field
                      id="stream-form-mirror-name"
                      label={t("streams.form.mirrorName")}
                      error={errors.mirror ? t(errors.mirror) : undefined}
                      errorKey="mirror"
                    >
                      <Input
                        id="stream-form-mirror-name"
                        data-testid="stream-form-mirror-name"
                        value={draft.mirrorName}
                        onChange={(e) => patch({ mirrorName: e.target.value })}
                      />
                    </Field>
                    <Field id="stream-form-mirror-filter" label={t("streams.form.mirrorFilter")}>
                      <Input
                        id="stream-form-mirror-filter"
                        data-testid="stream-form-mirror-filter"
                        value={draft.mirrorFilter}
                        onChange={(e) => patch({ mirrorFilter: e.target.value })}
                      />
                    </Field>
                    <Field id="stream-form-mirror-start" label={t("streams.form.mirrorStartSeq")}>
                      <Input
                        id="stream-form-mirror-start"
                        data-testid="stream-form-mirror-start"
                        inputMode="numeric"
                        value={draft.mirrorStartSeq}
                        onChange={(e) => patch({ mirrorStartSeq: e.target.value })}
                      />
                    </Field>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">{t("streams.form.sourcesList")}</span>
                  {draft.sources.map((row, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_100px_auto] items-end gap-2">
                      <Field
                        id={`stream-form-source-${i}-name`}
                        label={i === 0 ? t("streams.form.sourceName") : undefined}
                        error={i === 0 && errors.sources ? t(errors.sources) : undefined}
                        errorKey="sources"
                      >
                        <Input
                          id={`stream-form-source-${i}-name`}
                          data-testid={`stream-form-source-${i}-name`}
                          aria-label={t("streams.form.sourceName")}
                          value={row.name}
                          onChange={(e) => patchSource(i, { name: e.target.value })}
                        />
                      </Field>
                      <Field id={`stream-form-source-${i}-filter`} label={i === 0 ? t("streams.form.sourceFilter") : undefined}>
                        <Input
                          id={`stream-form-source-${i}-filter`}
                          data-testid={`stream-form-source-${i}-filter`}
                          aria-label={t("streams.form.sourceFilter")}
                          value={row.filter}
                          onChange={(e) => patchSource(i, { filter: e.target.value })}
                        />
                      </Field>
                      <Field id={`stream-form-source-${i}-seq`} label={i === 0 ? t("streams.form.sourceStartSeq") : undefined}>
                        <Input
                          id={`stream-form-source-${i}-seq`}
                          data-testid={`stream-form-source-${i}-seq`}
                          aria-label={t("streams.form.sourceStartSeq")}
                          inputMode="numeric"
                          value={row.startSeq}
                          onChange={(e) => patchSource(i, { startSeq: e.target.value })}
                        />
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-testid={`stream-form-source-${i}-remove`}
                        aria-label={t("common.delete")}
                        onClick={() => removeSource(i)}
                      >
                        <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="stream-form-add-source"
                    onClick={addSource}
                    className="self-start"
                  >
                    <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t("streams.form.addSource")}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            data-testid="stream-form-cancel"
            disabled={pending}
            onClick={() => onDone?.()}
          >
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="stream-form-submit"
            disabled={pending}
            onClick={() => void handleSubmit()}
          >
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {t(pending ? "streams.form.submitting" : submitKey)}
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
  errorKey,
  children,
}: {
  id: string;
  label?: string;
  hint?: string;
  error?: string;
  /** zod field path for the testid: stream-form-error-<field>. */
  errorKey?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label htmlFor={id}>{label}</Label>}
      {children}
      {hint && <p className="text-xs text-[var(--fg-muted)]">{hint}</p>}
      {error && errorKey && (
        <p
          role="alert"
          data-testid={`stream-form-error-${errorKey}`}
          className="text-xs text-[var(--danger-fg)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}
