/**
 * Base64 helpers for the Wails wire contract. Go encodes []byte payloads as
 * standard base64 (spec §7.3), so every message payload crossing the binding
 * boundary goes through here. Naive btoa/atob only work on Latin-1 strings —
 * these helpers route through UTF-8 bytes first so any Unicode payload
 * round-trips, and chunk the binary string build so multi-megabyte payloads
 * do not blow the argument limit of String.fromCharCode.
 */

/** UTF-8 encode an arbitrary JS string, then base64 it. */
export function toBase64(s: string): string {
  return toBase64Bytes(new TextEncoder().encode(s));
}

/** Base64 a raw byte sequence (the payload may legitimately be binary). */
export function toBase64Bytes(bytes: Uint8Array): string {
  // 0x8000-item chunks keep String.fromCharCode(...spread) far below the
  // engine's argument-count limit (8 MiB payloads are in spec for §6.3).
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Decode standard base64 into raw bytes (hex previews, binary detection). */
export function fromBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Decode standard base64 into a JS string via UTF-8. Invalid sequences
 * (true binary payloads) decode with replacement characters instead of
 * throwing — use fromBase64Bytes + a fatal TextDecoder to tell them apart.
 */
export function fromBase64(b64: string): string {
  return new TextDecoder().decode(fromBase64Bytes(b64));
}

/** Lowercase hex of a byte sequence, two chars per byte ("00ff…"). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
