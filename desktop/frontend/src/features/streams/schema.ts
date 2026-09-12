import { z } from "zod";
import type { StreamForm as StreamFormWire } from "../../lib/bindings";

/**
 * Client-side mirror of Go ValidateStreamForm (internal/jsadmin/forms.go) —
 * both sides must reject the same payloads (brief: 双侧对齐). Error messages
 * are i18n keys resolved by the caller.
 *
 * Name: non-empty after trim; every rune must be a letter, digit or one of
 * _ - . > * (Go validStreamName); a space anywhere is therefore illegal.
 * Subjects: at least one non-empty string unless a mirror is set; empty
 * subject strings are rejected exactly like the server.
 * Limits (max_msgs / max_bytes / max_msgs_per_subject): integers ≥ -1
 * (-1 = unlimited). max_age_seconds ≥ 0. replicas 1–5 (the server maps 0→1,
 * the form asks for an explicit value and defaults the draft to 1).
 * Mirror/sources: a present mirror needs a name; every source needs a name.
 */
const NAME_OK = /^[\p{L}\p{N}_.>*-]+$/u;

export const streamSourceSchema = z.object({
  name: z
    .string()
    .refine((s) => s.trim() !== "", "streams.form.sourceNameRequired"),
  filter_subject: z.string(),
  opt_start_seq: z.number().int("streams.form.seqInvalid").min(0, "streams.form.seqInvalid"),
});

export const streamFormSchema = z
  .object({
    name: z
      .string()
      .refine((s) => s.trim() !== "", "streams.form.nameRequired")
      .refine((s) => NAME_OK.test(s), "streams.form.nameIllegal"),
    description: z.string(),
    subjects: z.array(
      z.string().refine((s) => s.trim() !== "", "streams.form.subjectEmpty"),
    ),
    storage: z.enum(["file", "memory"], { message: "streams.form.storageRequired" }),
    retention: z.enum(["limits", "interest", "workqueue"], {
      message: "streams.form.retentionRequired",
    }),
    max_msgs: z.number().int("streams.form.limitsInvalid").min(-1, "streams.form.limitsInvalid"),
    max_bytes: z.number().int("streams.form.limitsInvalid").min(-1, "streams.form.limitsInvalid"),
    max_age_seconds: z.number().int("streams.form.ageInvalid").min(0, "streams.form.ageInvalid"),
    max_msgs_per_subject: z
      .number()
      .int("streams.form.limitsInvalid")
      .min(-1, "streams.form.limitsInvalid"),
    replicas: z
      .number()
      .int("streams.form.replicasInvalid")
      .min(1, "streams.form.replicasInvalid")
      .max(5, "streams.form.replicasInvalid"),
    placement_cluster: z.string(),
    placement_tags: z.array(z.string()),
    mirror: streamSourceSchema.nullable(),
    sources: z.array(streamSourceSchema),
  })
  // Go: `f.Mirror == nil && len(f.Subjects) == 0` → "at least one subject is
  // required unless mirroring".
  .refine((v) => v.mirror !== null || v.subjects.length > 0, {
    path: ["subjects"],
    message: "streams.form.subjectsRequired",
  });

export type StreamFormValues = z.infer<typeof streamFormSchema>;

/** Structural subset every mutation binding resolves with (CallResult /
 * PurgeResult both satisfy it). */
export interface ActionResult {
  error_code: string;
  error: string;
}

const int = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0);

/**
 * Values → wire. 0 stays 0 (nothing is dropped): every field is sent
 * explicitly because the Go side must never see missing/zero-value enums —
 * storage/retention are coerced to explicit non-empty members, optional
 * numerics become 0 ("0 = not set"), replicas is clamped to 1–5 (0 → 1, the
 * Go default) and mirror/sources keep their full shape.
 */
export const toWire = (v: StreamFormValues): StreamFormWire => ({
  name: v.name,
  description: v.description,
  subjects: [...v.subjects],
  storage: v.storage === "memory" ? "memory" : "file",
  retention:
    v.retention === "interest" || v.retention === "workqueue" ? v.retention : "limits",
  max_msgs: int(v.max_msgs),
  max_bytes: int(v.max_bytes),
  max_age_seconds: int(v.max_age_seconds),
  max_msgs_per_subject: int(v.max_msgs_per_subject),
  replicas: Math.min(5, Math.max(1, int(v.replicas) || 1)),
  placement_cluster: v.placement_cluster,
  placement_tags: [...v.placement_tags],
  mirror: v.mirror
    ? {
        name: v.mirror.name,
        filter_subject: v.mirror.filter_subject,
        opt_start_seq: int(v.mirror.opt_start_seq),
      }
    : null,
  sources: v.sources.map((s) => ({
    name: s.name,
    filter_subject: s.filter_subject,
    opt_start_seq: int(s.opt_start_seq),
  })),
});

/** Create-mode defaults: explicit enums, replicas 1, everything else unset. */
export const emptyStreamFormValues = (): StreamFormValues => ({
  name: "",
  description: "",
  subjects: [],
  storage: "file",
  retention: "limits",
  max_msgs: 0,
  max_bytes: 0,
  max_age_seconds: 0,
  max_msgs_per_subject: 0,
  replicas: 1,
  placement_cluster: "",
  placement_tags: [],
  mirror: null,
  sources: [],
});
