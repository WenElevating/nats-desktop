import { z } from "zod";

/**
 * Payload size policy (spec §6.3): the byte length is checked client-side on
 * the raw (pre-base64) payload string. 1–8 MiB warns with a confirmation
 * dialog; > 8 MiB is rejected outright. The bounds mirror the Go messaging
 * layer's MaxPayload (8 MiB, internal/messaging/pubreq.go).
 */
export const MIB = 1024 * 1024;
export const PAYLOAD_WARN_BYTES = MIB;
export const PAYLOAD_MAX_BYTES = 8 * MIB;

/**
 * One editable header row. Multiple rows may share a key — they are grouped
 * into string arrays on the wire (PubForm.headers is Record<string, string[]>).
 */
export interface HeaderRow {
  key: string;
  value: string;
}

/**
 * The publish/request form draft. Subject must be non-empty and free of
 * whitespace (inline interception). Payload length limits are deliberately
 * NOT encoded here — they carry confirm-dialog semantics and are enforced in
 * the component layer (spec §6.3).
 */
export const pubSchema = z.object({
  mode: z.enum(["publish", "request"]),
  subject: z
    .string()
    .min(1, "messages.subjectInvalid")
    .refine((s) => !/\s/.test(s), "messages.subjectInvalid"),
  headers: z.array(
    z.object({ key: z.string(), value: z.string() }),
  ),
  payload: z.string(),
  jetstream: z.boolean(),
  msgId: z.string(),
  timeoutMs: z.number().int(),
});
export type PubFormValues = z.infer<typeof pubSchema>;

/**
 * The trace form draft (spec §6.5). Same subject rules as pubSchema; payload
 * length is deliberately unchecked here — the Go Trace binding enforces
 * MaxPayload (ErrPayloadTooLarge) and the panel surfaces it through the
 * failure toast.
 */
export const traceSchema = z.object({
  subject: z
    .string()
    .min(1, "messages.subjectInvalid")
    .refine((s) => !/\s/.test(s), "messages.subjectInvalid"),
  headers: z.array(
    z.object({ key: z.string(), value: z.string() }),
  ),
  payload: z.string(),
  timeoutMs: z.number().int(),
});

/** Group header rows into the wire shape; blank keys are dropped, an empty
 * set becomes null (PubForm.headers is nullable). */
export function headersToWire(
  rows: HeaderRow[],
): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    (out[k] ??= []).push(r.value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** UTF-8 byte length of the raw payload string (pre-base64, spec §6.3). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
