import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../app/i18n";
import type { ConsumerForm as ConsumerFormWire } from "../../lib/bindings";
import { consumerFormSchema, type ActionResult, type ConsumerFormValues } from "./schema";
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

export type ConsumerFormMode = "create" | "edit" | "copy";

export interface ConsumerFormProps {
  open: boolean;
  mode: ConsumerFormMode;
  /** Parent stream the consumer lives on (create mode has no prefill). */
  stream: string;
  /** detail.form (wire) prefill for edit/copy; ignored for create. */
  initial?: ConsumerFormWire | null;
  /** Called with parsed+validated values (copy submits via CreateConsumer so
   * the operator's tweaks travel with the new consumer; edit via
   * UpdateConsumer — the caller decides). Returns the CallResult so
   * error_code=validation can render the server原文 inline; toasts/refresh
   * belong to the caller (useConsumers actions). */
  onSubmit: (
    values: ConsumerFormValues,
  ) => Promise<ActionResult | null | undefined> | ActionResult | null | undefined;
  /** Close request: after a successful submit or any user dismiss. */
  onDone?: () => void;
}

// ---- draft (the editable stringy shape of the form) ----

interface Draft {
  durable: string;
  description: string;
  deliverMode: string;
  deliverSubject: string;
  deliverGroup: string;
  filterSubjectsText: string;
  ackPolicy: string;
  ackWait: string;
  maxDeliver: string;
  maxWaiting: string;
  maxAckPending: string;
  maxRequestBatch: string;
  maxRequestExpires: string;
  maxRequestMaxBytes: string;
  backoffText: string;
  replayPolicy: string;
  deliverPolicy: string;
  optStartSeq: string;
  optStartTimeLocal: string;
  replicas: string;
  headersOnly: boolean;
  memoryStorage: boolean;
  inactiveThreshold: string;
}

const emptyDraft = (): Draft => ({
  durable: "",
  description: "",
  deliverMode: "pull",
  deliverSubject: "",
  deliverGroup: "",
  filterSubjectsText: "",
  ackPolicy: "explicit",
  ackWait: "",
  maxDeliver: "",
  maxWaiting: "",
  maxAckPending: "",
  maxRequestBatch: "",
  maxRequestExpires: "",
  maxRequestMaxBytes: "",
  backoffText: "",
  replayPolicy: "instant",
  deliverPolicy: "all",
  optStartSeq: "",
  optStartTimeLocal: "",
  replicas: "1",
  headersOnly: false,
  memoryStorage: false,
  inactiveThreshold: "",
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

/** ms epoch → datetime-local input value (local time, minute precision). */
const toLocalInput = (ms: number): string => {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Draft → schema values. Filter subjects are textarea lines (trimmed, blanks
 * dropped); backoff steps are comma-separated; the datetime-local string maps
 * to epoch ms (invalid/empty → 0, which start_time validation then rejects). */
const draftToValues = (d: Draft, stream: string): ConsumerFormValues => ({
  stream,
  durable: d.durable,
  description: d.description,
  deliver_mode: d.deliverMode === "push" ? "push" : "pull",
  deliver_subject: d.deliverSubject,
  deliver_group: d.deliverGroup,
  filter_subjects: d.filterSubjectsText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== ""),
  ack_policy: d.ackPolicy as ConsumerFormValues["ack_policy"],
  ack_wait_seconds: parseNum(d.ackWait),
  max_deliver: parseNum(d.maxDeliver),
  max_waiting: parseNum(d.maxWaiting),
  max_ack_pending: parseNum(d.maxAckPending),
  max_request_batch: parseNum(d.maxRequestBatch),
  max_request_expires_seconds: parseNum(d.maxRequestExpires),
  max_request_max_bytes: parseNum(d.maxRequestMaxBytes),
  backoff_seconds: d.backoffText
    .split(/[,\s]+/)
    .filter((s) => s !== "")
    .map(parseNum),
  replay_policy: d.replayPolicy as ConsumerFormValues["replay_policy"],
  deliver_policy: d.deliverPolicy as ConsumerFormValues["deliver_policy"],
  opt_start_seq: parseNum(d.optStartSeq),
  opt_start_time_ms: d.optStartTimeLocal ? new Date(d.optStartTimeLocal).getTime() || 0 : 0,
  priority_groups: [],
  headers_only: d.headersOnly,
  replicas: parseNum(d.replicas),
  memory_storage: d.memoryStorage,
  inactive_threshold_seconds: parseNum(d.inactiveThreshold),
});

/** Wire (detail.form) → draft, for the edit/copy prefill. */
const wireToDraft = (w: ConsumerFormWire): Draft => ({
  durable: w.durable ?? "",
  description: w.description ?? "",
  deliverMode: w.deliver_mode === "push" ? "push" : "pull",
  deliverSubject: w.deliver_subject ?? "",
  deliverGroup: w.deliver_group ?? "",
  filterSubjectsText: (w.filter_subjects ?? []).join("\n"),
  ackPolicy: w.ack_policy || "explicit",
  ackWait: numToInput(w.ack_wait_seconds),
  maxDeliver: numToInput(w.max_deliver),
  maxWaiting: numToInput(w.max_waiting),
  maxAckPending: numToInput(w.max_ack_pending),
  maxRequestBatch: numToInput(w.max_request_batch),
  maxRequestExpires: numToInput(w.max_request_expires_seconds),
  maxRequestMaxBytes: numToInput(w.max_request_max_bytes),
  backoffText: (w.backoff_seconds ?? []).join(", "),
  replayPolicy: w.replay_policy || "instant",
  deliverPolicy: w.deliver_policy || "all",
  optStartSeq: numToInput(w.opt_start_seq),
  optStartTimeLocal: toLocalInput(w.opt_start_time_ms ?? 0),
  replicas: numToInput(w.replicas) || "1",
  headersOnly: Boolean(w.headers_only),
  memoryStorage: Boolean(w.memory_storage),
  inactiveThreshold: numToInput(w.inactive_threshold_seconds),
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

export function ConsumerForm({ open, mode, stream, initial, onSubmit, onDone }: ConsumerFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  const [pending, setPending] = useState(false);

  // Prefill reads `initial` through a ref at open/mode-change time only — the
  // 5s detail poll replaces the detail object constantly and must never
  // clobber what the operator is typing.
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  useEffect(() => {
    if (!open) return;
    const src = initialRef.current;
    if (mode !== "create" && src) {
      // Copy prefills everything EXCEPT the name (the operator must choose a
      // fresh one); edit keeps it (frozen input below).
      setDraft({ ...wireToDraft(src), ...(mode === "copy" ? { durable: "" } : {}) });
    } else {
      setDraft(emptyDraft());
    }
    setErrors({});
    setServerError("");
    setPending(false);
  }, [open, mode]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const handleSubmit = async () => {
    if (pending) return;
    const parsed = consumerFormSchema.safeParse(draftToValues(draft, streamRef.current));
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
    mode === "edit"
      ? "consumers.form.titleEdit"
      : mode === "copy"
        ? "consumers.form.titleCopy"
        : "consumers.form.titleCreate";
  const submitKey =
    mode === "edit"
      ? "consumers.form.submitEdit"
      : mode === "copy"
        ? "consumers.form.submitCopy"
        : "consumers.form.submitCreate";

  const editing = mode === "edit";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onDone?.();
      }}
    >
      <DialogContent
        data-testid="consumer-form"
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle data-testid="consumer-form-title">
            {t(titleKey, { name: editing ? draft.durable : "" })}
          </DialogTitle>
        </DialogHeader>

        {serverError && (
          <div
            role="alert"
            data-testid="consumer-form-server-error"
            className="rounded-md border border-[var(--danger-fg)] px-3 py-2 text-sm text-[var(--danger-fg)]"
          >
            {serverError}
          </div>
        )}

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="consumer-form-durable"
              label={t("consumers.form.durable")}
              hint={t("consumers.form.durableHint")}
              error={errors.durable ? t(errors.durable) : undefined}
              errorKey="durable"
            >
              {/* Edit renames would be "create as new" on the server, so the
                  name is frozen in edit mode (copy mode needs it empty). */}
              <Input
                id="consumer-form-durable"
                data-testid="consumer-form-durable"
                value={draft.durable}
                disabled={editing}
                aria-invalid={errors.durable ? true : undefined}
                onChange={(e) => patch({ durable: e.target.value })}
              />
            </Field>
            <Field id="consumer-form-description" label={t("consumers.form.description")}>
              <Input
                id="consumer-form-description"
                data-testid="consumer-form-description"
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              id="consumer-form-deliver-mode"
              label={t("consumers.form.deliverMode")}
              error={errors.deliver_mode ? t(errors.deliver_mode) : undefined}
              errorKey="deliver_mode"
            >
              <select
                id="consumer-form-deliver-mode"
                data-testid="consumer-form-deliver-mode"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={draft.deliverMode}
                onChange={(e) => patch({ deliverMode: e.target.value })}
              >
                <option value="pull">{t("consumers.form.pull")}</option>
                <option value="push">{t("consumers.form.push")}</option>
              </select>
            </Field>
            {draft.deliverMode === "push" && (
              <>
                <Field
                  id="consumer-form-deliver-subject"
                  label={t("consumers.form.deliverSubject")}
                  error={errors.deliver_subject ? t(errors.deliver_subject) : undefined}
                  errorKey="deliver_subject"
                >
                  <Input
                    id="consumer-form-deliver-subject"
                    data-testid="consumer-form-deliver-subject"
                    value={draft.deliverSubject}
                    aria-invalid={errors.deliver_subject ? true : undefined}
                    onChange={(e) => patch({ deliverSubject: e.target.value })}
                  />
                </Field>
                <Field id="consumer-form-deliver-group" label={t("consumers.form.deliverGroup")}>
                  <Input
                    id="consumer-form-deliver-group"
                    data-testid="consumer-form-deliver-group"
                    value={draft.deliverGroup}
                    onChange={(e) => patch({ deliverGroup: e.target.value })}
                  />
                </Field>
              </>
            )}
          </div>

          <Field
            id="consumer-form-filter-subjects"
            label={t("consumers.form.filterSubjects")}
            hint={t("consumers.form.filterSubjectsHint")}
            error={errors.filter_subjects ? t(errors.filter_subjects) : undefined}
            errorKey="filter_subjects"
          >
            <textarea
              id="consumer-form-filter-subjects"
              data-testid="consumer-form-filter-subjects"
              rows={2}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
              aria-invalid={errors.filter_subjects ? true : undefined}
              placeholder={"orders.>\nshipping.*"}
              value={draft.filterSubjectsText}
              onChange={(e) => patch({ filterSubjectsText: e.target.value })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="consumer-form-ack-policy"
              label={t("consumers.form.ackPolicy")}
              error={errors.ack_policy ? t(errors.ack_policy) : undefined}
              errorKey="ack_policy"
            >
              <select
                id="consumer-form-ack-policy"
                data-testid="consumer-form-ack-policy"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={draft.ackPolicy}
                onChange={(e) => patch({ ackPolicy: e.target.value })}
              >
                <option value="explicit">{t("consumers.form.ackExplicit")}</option>
                <option value="none">{t("consumers.form.ackNone")}</option>
                <option value="all">{t("consumers.form.ackAll")}</option>
              </select>
            </Field>
            <Field
              id="consumer-form-ack-wait"
              label={t("consumers.form.ackWait")}
              error={errors.ack_wait_seconds ? t(errors.ack_wait_seconds) : undefined}
              errorKey="ack_wait_seconds"
            >
              <Input
                id="consumer-form-ack-wait"
                data-testid="consumer-form-ack-wait"
                inputMode="numeric"
                placeholder="30"
                value={draft.ackWait}
                onChange={(e) => patch({ ackWait: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              id="consumer-form-max-deliver"
              label={t("consumers.form.maxDeliver")}
              error={errors.max_deliver ? t(errors.max_deliver) : undefined}
              errorKey="max_deliver"
            >
              <Input
                id="consumer-form-max-deliver"
                data-testid="consumer-form-max-deliver"
                inputMode="numeric"
                placeholder="0"
                value={draft.maxDeliver}
                onChange={(e) => patch({ maxDeliver: e.target.value })}
              />
            </Field>
            <Field
              id="consumer-form-max-waiting"
              label={t("consumers.form.maxWaiting")}
              error={errors.max_waiting ? t(errors.max_waiting) : undefined}
              errorKey="max_waiting"
            >
              <Input
                id="consumer-form-max-waiting"
                data-testid="consumer-form-max-waiting"
                inputMode="numeric"
                placeholder="0"
                value={draft.maxWaiting}
                onChange={(e) => patch({ maxWaiting: e.target.value })}
              />
            </Field>
            <Field
              id="consumer-form-max-ack-pending"
              label={t("consumers.form.maxAckPending")}
              error={errors.max_ack_pending ? t(errors.max_ack_pending) : undefined}
              errorKey="max_ack_pending"
            >
              <Input
                id="consumer-form-max-ack-pending"
                data-testid="consumer-form-max-ack-pending"
                inputMode="numeric"
                placeholder="0"
                value={draft.maxAckPending}
                onChange={(e) => patch({ maxAckPending: e.target.value })}
              />
            </Field>
            <Field
              id="consumer-form-max-request-batch"
              label={t("consumers.form.maxRequestBatch")}
              error={errors.max_request_batch ? t(errors.max_request_batch) : undefined}
              errorKey="max_request_batch"
            >
              <Input
                id="consumer-form-max-request-batch"
                data-testid="consumer-form-max-request-batch"
                inputMode="numeric"
                placeholder="0"
                value={draft.maxRequestBatch}
                onChange={(e) => patch({ maxRequestBatch: e.target.value })}
              />
            </Field>
            <Field
              id="consumer-form-max-request-expires"
              label={t("consumers.form.maxRequestExpires")}
              error={
                errors.max_request_expires_seconds
                  ? t(errors.max_request_expires_seconds)
                  : undefined
              }
              errorKey="max_request_expires_seconds"
            >
              <Input
                id="consumer-form-max-request-expires"
                data-testid="consumer-form-max-request-expires"
                inputMode="numeric"
                placeholder="0"
                value={draft.maxRequestExpires}
                onChange={(e) => patch({ maxRequestExpires: e.target.value })}
              />
            </Field>
            <Field
              id="consumer-form-max-request-max-bytes"
              label={t("consumers.form.maxRequestMaxBytes")}
              error={errors.max_request_max_bytes ? t(errors.max_request_max_bytes) : undefined}
              errorKey="max_request_max_bytes"
            >
              <Input
                id="consumer-form-max-request-max-bytes"
                data-testid="consumer-form-max-request-max-bytes"
                inputMode="numeric"
                placeholder="0"
                value={draft.maxRequestMaxBytes}
                onChange={(e) => patch({ maxRequestMaxBytes: e.target.value })}
              />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-[var(--fg-muted)]">{t("consumers.form.backoffHint")}</p>

          <Field
            id="consumer-form-backoff"
            label={t("consumers.form.backoff")}
            error={errors.backoff_seconds ? t(errors.backoff_seconds) : undefined}
            errorKey="backoff_seconds"
          >
            <Input
              id="consumer-form-backoff"
              data-testid="consumer-form-backoff"
              placeholder="30, 60, 300"
              value={draft.backoffText}
              onChange={(e) => patch({ backoffText: e.target.value })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="consumer-form-replay-policy"
              label={t("consumers.form.replayPolicy")}
              error={errors.replay_policy ? t(errors.replay_policy) : undefined}
              errorKey="replay_policy"
            >
              <select
                id="consumer-form-replay-policy"
                data-testid="consumer-form-replay-policy"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={draft.replayPolicy}
                onChange={(e) => patch({ replayPolicy: e.target.value })}
              >
                <option value="instant">{t("consumers.form.replayInstant")}</option>
                <option value="original">{t("consumers.form.replayOriginal")}</option>
              </select>
            </Field>
            <Field
              id="consumer-form-deliver-policy"
              label={t("consumers.form.deliverPolicy")}
              error={errors.deliver_policy ? t(errors.deliver_policy) : undefined}
              errorKey="deliver_policy"
            >
              {/* Server-immutable on update (Go merges the live deliver
                  policy; a drifted value is rejected with the 400原文) — the
                  select is frozen in edit mode. */}
              <select
                id="consumer-form-deliver-policy"
                data-testid="consumer-form-deliver-policy"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={draft.deliverPolicy}
                disabled={editing}
                onChange={(e) => patch({ deliverPolicy: e.target.value })}
              >
                <option value="all">{t("consumers.form.dpAll")}</option>
                <option value="last">{t("consumers.form.dpLast")}</option>
                <option value="new">{t("consumers.form.dpNew")}</option>
                <option value="start_sequence">{t("consumers.form.dpStartSequence")}</option>
                <option value="start_time">{t("consumers.form.dpStartTime")}</option>
              </select>
            </Field>
          </div>

          {draft.deliverPolicy === "start_sequence" && (
            <Field
              id="consumer-form-opt-start-seq"
              label={t("consumers.form.optStartSeq")}
              error={errors.opt_start_seq ? t(errors.opt_start_seq) : undefined}
              errorKey="opt_start_seq"
            >
              <Input
                id="consumer-form-opt-start-seq"
                data-testid="consumer-form-opt-start-seq"
                inputMode="numeric"
                min={1}
                value={draft.optStartSeq}
                disabled={editing}
                onChange={(e) => patch({ optStartSeq: e.target.value })}
              />
            </Field>
          )}
          {draft.deliverPolicy === "start_time" && (
            <Field
              id="consumer-form-opt-start-time"
              label={t("consumers.form.optStartTime")}
              error={errors.opt_start_time_ms ? t(errors.opt_start_time_ms) : undefined}
              errorKey="opt_start_time_ms"
            >
              <Input
                id="consumer-form-opt-start-time"
                data-testid="consumer-form-opt-start-time"
                type="datetime-local"
                value={draft.optStartTimeLocal}
                disabled={editing}
                onChange={(e) => patch({ optStartTimeLocal: e.target.value })}
              />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-4">
            <Field
              id="consumer-form-replicas"
              label={t("consumers.form.replicas")}
              error={errors.replicas ? t(errors.replicas) : undefined}
              errorKey="replicas"
            >
              <Input
                id="consumer-form-replicas"
                data-testid="consumer-form-replicas"
                inputMode="numeric"
                className="w-20"
                value={draft.replicas}
                onChange={(e) => patch({ replicas: e.target.value })}
              />
            </Field>
            <Field
              id="consumer-form-inactive-threshold"
              label={t("consumers.form.inactiveThreshold")}
              error={
                errors.inactive_threshold_seconds
                  ? t(errors.inactive_threshold_seconds)
                  : undefined
              }
              errorKey="inactive_threshold_seconds"
            >
              <Input
                id="consumer-form-inactive-threshold"
                data-testid="consumer-form-inactive-threshold"
                inputMode="numeric"
                value={draft.inactiveThreshold}
                onChange={(e) => patch({ inactiveThreshold: e.target.value })}
              />
            </Field>
            <label className="mt-6 flex cursor-pointer items-center gap-2 text-sm">
              <input
                id="consumer-form-headers-only"
                type="checkbox"
                data-testid="consumer-form-headers-only"
                checked={draft.headersOnly}
                onChange={(e) => patch({ headersOnly: e.target.checked })}
              />
              {t("consumers.form.headersOnly")}
            </label>
            <label className="mt-6 flex cursor-pointer items-center gap-2 text-sm">
              <input
                id="consumer-form-memory-storage"
                type="checkbox"
                data-testid="consumer-form-memory-storage"
                checked={draft.memoryStorage}
                onChange={(e) => patch({ memoryStorage: e.target.checked })}
              />
              {t("consumers.form.memoryStorage")}
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            data-testid="consumer-form-cancel"
            disabled={pending}
            onClick={() => onDone?.()}
          >
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="consumer-form-submit"
            disabled={pending}
            onClick={() => void handleSubmit()}
          >
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {t(pending ? "consumers.form.submitting" : submitKey)}
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
  /** zod field path for the testid: consumer-form-error-<field>. */
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
          data-testid={`consumer-form-error-${errorKey}`}
          className="text-xs text-[var(--danger-fg)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}
