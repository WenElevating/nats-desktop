import { z } from "zod";
import type { KvBucketForm } from "../../lib/bindings";
import { MIB, utf8Length } from "../messages/schema";

/**
 * Client-side mirror of the Go buckets validators (internal/buckets/forms.go)
 * — both sides must reject the same payloads (brief: 与 Go 校验同规则). Error
 * messages are i18n keys resolved by the caller.
 *
 * Bucket form (ValidateKvBucketForm):
 * - name: `^[a-zA-Z0-9_-]+$` (non-empty implied by the regex).
 * - history: integer 0–64; 0 = server default (1), 1–64 explicit — the Go
 *   validator rejects only history > 64 ("between 1 and 64 (0 = default)").
 * - ttl_seconds ≥ 0 (0 = never expires). max_bytes / max_value_size ≥ -1
 *   (-1 = unlimited). replicas 0–5; 0 = server default (1), the form draft
 *   defaults to an explicit 1.
 *
 * Key editor (ValidateKeyName + ValidatePayloadSize):
 * - key: `^[-/_=.a-zA-Z0-9]+$` ('/' legal for natscli interop), no
 *   leading/trailing dot and no "..".
 * - value: at most 8 MiB of UTF-8 text (Go MaxValueBytes cap; the byte length
 *   is checked on the raw pre-base64 string, spec §6.3 wording).
 * - mode: explicit put | create | update enum (Go PutKey modes).
 */
const BUCKET_NAME_OK = /^[a-zA-Z0-9_-]+$/;
const KEY_NAME_OK = /^[-/_=.a-zA-Z0-9]+$/;

export const MAX_VALUE_BYTES = 8 * MIB;

export const bucketFormSchema = z.object({
  name: z
    .string()
    .refine((s) => BUCKET_NAME_OK.test(s), "kv.form.nameIllegal"),
  description: z.string(),
  history: z.number().int("kv.form.numericInvalid").min(0, "kv.form.historyInvalid").max(64, "kv.form.historyInvalid"),
  ttl_seconds: z.number().int("kv.form.numericInvalid").min(0, "kv.form.ttlInvalid"),
  max_bytes: z.number().int("kv.form.numericInvalid").min(-1, "kv.form.limitsInvalid"),
  replicas: z
    .number()
    .int("kv.form.numericInvalid")
    .min(0, "kv.form.replicasInvalid")
    .max(5, "kv.form.replicasInvalid"),
  max_value_size: z.number().int("kv.form.numericInvalid").min(-1, "kv.form.limitsInvalid"),
});

export type BucketFormValues = z.infer<typeof bucketFormSchema>;

export const keyModeSchema = z.enum(["put", "create", "update"], {
  message: "kv.editor.modeInvalid",
});
export type KeyMode = z.infer<typeof keyModeSchema>;

/** A key must not be empty, start/end with '.', or contain '..' (Go ValidateKeyName). */
export const isValidKeyName = (key: string): boolean =>
  key.length > 0 &&
  key[0] !== "." &&
  key[key.length - 1] !== "." &&
  !key.includes("..") &&
  KEY_NAME_OK.test(key);

export const keyEditorSchema = z.object({
  key: z.string().refine(isValidKeyName, "kv.editor.keyIllegal"),
  mode: keyModeSchema,
  value: z
    .string()
    .refine((s) => utf8Length(s) <= MAX_VALUE_BYTES, "kv.editor.tooLarge"),
  expected_revision: z.number().int("kv.editor.expectedInvalid").min(0, "kv.editor.expectedInvalid"),
});

export type KeyEditorValues = z.infer<typeof keyEditorSchema>;

const int = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0);

/** Bucket values → wire. Every numeric field is sent explicitly; the Go
 * validator re-normalizes 0-history/0-replicas to its defaults. */
export const bucketFormToWire = (v: BucketFormValues): KvBucketForm => ({
  name: v.name,
  description: v.description,
  history: int(v.history),
  ttl_seconds: int(v.ttl_seconds),
  max_bytes: int(v.max_bytes),
  replicas: int(v.replicas),
  max_value_size: int(v.max_value_size),
});

/** Create-mode bucket defaults: replicas 1, everything else unset (0). */
export const emptyBucketFormValues = (): BucketFormValues => ({
  name: "",
  description: "",
  history: 0,
  ttl_seconds: 0,
  max_bytes: 0,
  replicas: 1,
  max_value_size: 0,
});

/** Structural subset every mutation binding resolves with (CallResult). */
export interface ActionResult {
  error_code: string;
  error: string;
}

/** First zod issue message (an i18n key) per top-level field. */
export const collectErrors = (
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
};
