import { z } from "zod";
import type { ObjBucketForm } from "../../lib/bindings";
import { collectErrors, type ActionResult } from "../kv/schema";

/**
 * Client-side mirror of the Go object-store validators (internal/buckets
 * forms.go ValidateObjBucketForm) — both sides must reject the same payloads.
 * Error messages are i18n keys resolved by the caller.
 *
 * Object bucket form (ValidateObjBucketForm):
 * - name: `^[a-zA-Z0-9_-]+$` (non-empty implied by the regex) — the same
 *   charset as KV buckets.
 * - max_bytes ≥ -1 (-1 = unlimited).
 * - replicas 0–5; 0 = server default (1, the Go validator normalizes), the
 *   form draft defaults to an explicit 1.
 *
 * Rename (UI gate only — the Go RenameObject takes the new name verbatim):
 * non-empty after trimming.
 *
 * Upload queue item: a picked path plus an optional target name ("" = keep
 * the file's basename, resolved server-side by UploadObject).
 */
const OBJ_NAME_OK = /^[a-zA-Z0-9_-]+$/;

export const objBucketFormSchema = z.object({
  name: z
    .string()
    .refine((s) => OBJ_NAME_OK.test(s), "objects.form.nameIllegal"),
  description: z.string(),
  max_bytes: z.number().int("objects.form.numericInvalid").min(-1, "objects.form.limitsInvalid"),
  replicas: z
    .number()
    .int("objects.form.numericInvalid")
    .min(0, "objects.form.replicasInvalid")
    .max(5, "objects.form.replicasInvalid"),
});

export type ObjBucketFormValues = z.infer<typeof objBucketFormSchema>;

/** A rename target must be non-empty (whitespace-only counts as empty). */
export const renameNameSchema = z
  .string()
  .refine((s) => s.trim().length > 0, "objects.rename.empty");

export const uploadItemSchema = z.object({
  path: z.string().min(1, "objects.upload.pathEmpty"),
  rename: z.string(),
});

export type UploadItemValues = z.infer<typeof uploadItemSchema>;

const int = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0);

/** Bucket values → wire. Numerics are sent explicitly; the Go validator
 * re-normalizes 0-replicas to its default of 1. */
export const objBucketFormToWire = (v: ObjBucketFormValues): ObjBucketForm => ({
  name: v.name,
  description: v.description,
  max_bytes: int(v.max_bytes),
  replicas: int(v.replicas),
});

/** Create-mode bucket defaults: replicas 1, max_bytes unset (0). */
export const emptyObjBucketFormValues = (): ObjBucketFormValues => ({
  name: "",
  description: "",
  max_bytes: 0,
  replicas: 1,
});

/** Last path segment across native separators (display + upload linking). */
export const basename = (p: string): string => {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
};

/**
 * Join a picked directory with an object name for OpenInFileManager. The
 * separator follows the directory itself (it comes from the native picker, so
 * on Windows it carries backslashes); the Go side filepath.Clean normalizes
 * either way.
 */
export const joinFilePath = (dir: string, name: string): string => {
  if (!dir) return name;
  if (dir.endsWith("\\") || dir.endsWith("/")) return `${dir}${name}`;
  return `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;
};

export { collectErrors, type ActionResult };
