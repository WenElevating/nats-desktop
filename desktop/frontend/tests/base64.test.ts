import { describe, it, expect } from "vitest";
import {
  toBase64,
  fromBase64,
  fromBase64Bytes,
  toBase64Bytes,
  bytesToHex,
} from "../src/lib/base64";

describe("base64 helpers (wire contract for Go []byte payloads)", () => {
  it("encodes ASCII exactly like btoa", () => {
    expect(toBase64("hello")).toBe("aGVsbG8=");
    expect(toBase64("")).toBe("");
  });

  it("round-trips non-Latin1 text that would crash plain btoa", () => {
    // U+20AC (€) is outside Latin-1; btoa("€") throws InvalidCharacterError.
    const s = "价格 €100 — ok 🌍";
    expect(fromBase64(toBase64(s))).toBe(s);
  });

  it("encodes raw bytes deterministically", () => {
    expect(toBase64Bytes(new Uint8Array([0x00, 0xff, 0x80]))).toBe("AP+A");
    expect(toBase64Bytes(new Uint8Array())).toBe("");
  });

  it("round-trips binary bytes that are not valid UTF-8", () => {
    const bytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0xc0, 0x01]);
    expect(fromBase64Bytes(toBase64Bytes(bytes))).toEqual(bytes);
  });

  it("handles multi-megabyte payloads without a fromCharCode overflow", () => {
    // 1 MiB spans 32 internal 0x8000 chunks (the 8 MiB §6.3 path scales).
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const back = fromBase64Bytes(toBase64Bytes(bytes));
    expect(back.length).toBe(bytes.length);
    expect(back[0]).toBe(0);
    expect(back[32767]).toBe(0xff);
    expect(back[32768]).toBe(0);
    expect(back[bytes.length - 1]).toBe((bytes.length - 1) & 0xff);
  }, 15000);

  it("decodes base64 back to text", () => {
    expect(fromBase64("aGVsbG8=")).toBe("hello");
    expect(fromBase64("")).toBe("");
  });

  it("fromBase64Bytes exposes raw bytes for hex previews", () => {
    expect(bytesToHex(fromBase64Bytes("AP+A"))).toBe("00ff80");
  });

  it("bytesToHex pads and handles empty input", () => {
    expect(bytesToHex(new Uint8Array([0x01, 0x0f, 0xab]))).toBe("010fab");
    expect(bytesToHex(new Uint8Array())).toBe("");
  });

  it("binary (non-UTF-8) payload survives fromBase64 without throwing", () => {
    // Replacement-char behavior is the documented fallback; a fatal decode
    // (TextDecoder fatal:true) is the component-level binary detector.
    expect(() => fromBase64("AP+A")).not.toThrow();
  });
});
