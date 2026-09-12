import { z } from "zod";
import type { ConsumerForm as ConsumerFormWire } from "../../lib/bindings";

/**
 * Client-side mirror of Go ValidateConsumerForm (internal/jsadmin/forms.go) —
 * both sides must reject the same payloads (brief: 双侧对齐). Error messages
 * are i18n keys resolved by the caller.
 *
 * Rules (Go parity):
 * - stream non-empty; durable non-empty and free of `.`, `*`, `>` (Go
 *   validDurableName).
 * - deliver_mode pull|push; push requires a non-empty deliver_subject.
 * - filter_subjects: at most 10 entries, none empty after trim.
 * - ack_policy explicit|none|all; replay_policy instant|original.
 * - ack_wait_seconds / max_request_expires_seconds ≥ 0; max_deliver /
 *   max_waiting / max_ack_pending / max_request_batch / max_request_max_bytes
 *   ≥ 0 (Go: "count limits must be >= 0").
 * - backoff_seconds: each ≥ 1, at most 100 entries.
 * - deliver_policy all|last|new|start_sequence|start_time; start_sequence
 *   needs opt_start_seq ≥ 1, start_time needs opt_start_time_ms > 0.
 * - priority_groups: non-empty entries allowed at the form layer — the
 *   feature is server-gated (2.11) and the v1 form never exposes it, so the
 *   array is carried through untouched (usually empty).
 */
export const consumerFormSchema = z
  .object({
    stream: z.string().refine((s) => s.trim() !== "", "consumers.form.streamRequired"),
    durable: z
      .string()
      .refine((s) => s.trim() !== "", "consumers.form.durableRequired")
      .refine((s) => !/[.*>]/.test(s), "consumers.form.durableIllegal"),
    description: z.string(),
    deliver_mode: z.enum(["pull", "push"], { message: "consumers.form.deliverModeRequired" }),
    deliver_subject: z.string(),
    deliver_group: z.string(),
    filter_subjects: z
      .array(z.string().refine((s) => s.trim() !== "", "consumers.form.filterSubjectEmpty"))
      .max(10, "consumers.form.filterSubjectsTooMany"),
    ack_policy: z.enum(["explicit", "none", "all"], {
      message: "consumers.form.ackPolicyRequired",
    }),
    ack_wait_seconds: z
      .number()
      .int("consumers.form.secondsInvalid")
      .min(0, "consumers.form.secondsInvalid"),
    max_deliver: z.number().int("consumers.form.countInvalid").min(0, "consumers.form.countInvalid"),
    max_waiting: z.number().int("consumers.form.countInvalid").min(0, "consumers.form.countInvalid"),
    max_ack_pending: z
      .number()
      .int("consumers.form.countInvalid")
      .min(0, "consumers.form.countInvalid"),
    max_request_batch: z
      .number()
      .int("consumers.form.countInvalid")
      .min(0, "consumers.form.countInvalid"),
    max_request_expires_seconds: z
      .number()
      .int("consumers.form.secondsInvalid")
      .min(0, "consumers.form.secondsInvalid"),
    max_request_max_bytes: z
      .number()
      .int("consumers.form.countInvalid")
      .min(0, "consumers.form.countInvalid"),
    backoff_seconds: z
      .array(
        z.number().int("consumers.form.backoffInvalid").min(1, "consumers.form.backoffInvalid"),
      )
      .max(100, "consumers.form.backoffTooMany"),
    replay_policy: z.enum(["instant", "original"], {
      message: "consumers.form.replayPolicyRequired",
    }),
    deliver_policy: z.enum(["all", "last", "new", "start_sequence", "start_time"], {
      message: "consumers.form.deliverPolicyRequired",
    }),
    opt_start_seq: z.number().int("consumers.form.startSeqInvalid"),
    opt_start_time_ms: z.number().int("consumers.form.startTimeInvalid"),
    priority_groups: z.array(z.string()),
    headers_only: z.boolean(),
    replicas: z.number().int("consumers.form.countInvalid").min(0, "consumers.form.countInvalid"),
    memory_storage: z.boolean(),
    inactive_threshold_seconds: z
      .number()
      .int("consumers.form.secondsInvalid")
      .min(0, "consumers.form.secondsInvalid"),
  })
  // Go: `push` consumers must carry a deliver subject.
  .refine((v) => v.deliver_mode !== "push" || v.deliver_subject.trim() !== "", {
    path: ["deliver_subject"],
    message: "consumers.form.deliverSubjectRequired",
  })
  // Go: start_sequence → OptStartSeq ≥ 1; start_time → OptStartTimeMs > 0.
  .refine((v) => v.deliver_policy !== "start_sequence" || v.opt_start_seq >= 1, {
    path: ["opt_start_seq"],
    message: "consumers.form.startSeqRequired",
  })
  .refine((v) => v.deliver_policy !== "start_time" || v.opt_start_time_ms > 0, {
    path: ["opt_start_time_ms"],
    message: "consumers.form.startTimeRequired",
  });

export type ConsumerFormValues = z.infer<typeof consumerFormSchema>;

/** Structural subset every mutation binding resolves with (CallResult). */
export interface ActionResult {
  error_code: string;
  error: string;
}

const int = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0);

/**
 * Values → wire. Numerics are truncated to explicit integers (empty → 0 =
 * server default) and enums are sent as their exact closed-set members so the
 * Go side never sees a missing/zero-value enum.
 */
export const toWire = (v: ConsumerFormValues): ConsumerFormWire => ({
  stream: v.stream,
  durable: v.durable,
  description: v.description,
  deliver_mode: v.deliver_mode === "push" ? "push" : "pull",
  deliver_subject: v.deliver_subject,
  deliver_group: v.deliver_group,
  filter_subjects: [...v.filter_subjects],
  ack_policy: v.ack_policy,
  ack_wait_seconds: int(v.ack_wait_seconds),
  max_deliver: int(v.max_deliver),
  max_waiting: int(v.max_waiting),
  max_ack_pending: int(v.max_ack_pending),
  max_request_batch: int(v.max_request_batch),
  max_request_expires_seconds: int(v.max_request_expires_seconds),
  max_request_max_bytes: int(v.max_request_max_bytes),
  backoff_seconds: v.backoff_seconds.map(int),
  replay_policy: v.replay_policy === "original" ? "original" : "instant",
  deliver_policy: v.deliver_policy,
  opt_start_seq: int(v.opt_start_seq),
  opt_start_time_ms: int(v.opt_start_time_ms),
  priority_groups: [...v.priority_groups],
  headers_only: v.headers_only,
  replicas: int(v.replicas),
  memory_storage: v.memory_storage,
  inactive_threshold_seconds: int(v.inactive_threshold_seconds),
});

/** Create-mode defaults: explicit enums, everything else unset. */
export const emptyConsumerFormValues = (): ConsumerFormValues => ({
  stream: "",
  durable: "",
  description: "",
  deliver_mode: "pull",
  deliver_subject: "",
  deliver_group: "",
  filter_subjects: [],
  ack_policy: "explicit",
  ack_wait_seconds: 0,
  max_deliver: 0,
  max_waiting: 0,
  max_ack_pending: 0,
  max_request_batch: 0,
  max_request_expires_seconds: 0,
  max_request_max_bytes: 0,
  backoff_seconds: [],
  replay_policy: "instant",
  deliver_policy: "all",
  opt_start_seq: 0,
  opt_start_time_ms: 0,
  priority_groups: [],
  headers_only: false,
  replicas: 1,
  memory_storage: false,
  inactive_threshold_seconds: 0,
});

/**
 * Formats a remaining pause duration as a compact countdown, rounded up to the
 * next second so "just under a minute" never reads as 0m. ≥ 1h drops the
 * seconds (a 1h-scale countdown ticking per second is noise).
 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}
