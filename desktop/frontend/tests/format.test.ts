import { describe, expect, it } from "vitest";
import { formatBytes } from "../src/lib/format";

// M6 Task 8 ㉔: the single B→TiB byte formatter (replaces the MiB-capped
// messages-page copy, NodeDetail's local formatSize, and DashboardPage's
// local formatSize). The table pins the exact strings the suites rely on:
// "2.0 KiB" (connections/kv/streams), "16 KiB" (accounts reserved store),
// "9.0 MiB" (publish reject copy), "1.0 GiB" (JS store limit).
describe("formatBytes (lib/format single ladder)", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [2048, "2.0 KiB"],
    [8192, "8.0 KiB"],
    [16 * 1024, "16 KiB"], // ≥10 of a unit: no decimals
    [1024 * 1024, "1.0 MiB"],
    [5 * 1024 * 1024, "5.0 MiB"],
    [9 * 1024 * 1024, "9.0 MiB"],
    [123_456_789, "118 MiB"],
    [1024 ** 3, "1.0 GiB"],
    [2 * 1024 ** 3, "2.0 GiB"],
    [1024 ** 4, "1.0 TiB"],
    [3.5 * 1024 ** 4, "3.5 TiB"],
  ])("formatBytes(%s) === %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it("never renders negative or non-finite input (负数不出现)", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(-(1024 ** 3))).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    const rendered = formatBytes(-5) + formatBytes(Number.NaN);
    expect(rendered).not.toContain("-");
  });

  it("caps the ladder at maxUnit (MiB ceiling for the MaxPayload wording)", () => {
    expect(formatBytes(2 * 1024 ** 3, { maxUnit: "MiB" })).toBe("2048 MiB");
    expect(formatBytes(9 * 1024 * 1024, { maxUnit: "MiB" })).toBe("9.0 MiB");
  });

  it("does not emit GiB for large payloads under the MiB ceiling", () => {
    expect(formatBytes(8 * 1024 * 1024 + 1, { maxUnit: "MiB" })).not.toContain("GiB");
  });
});
