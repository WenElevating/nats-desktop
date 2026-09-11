import { describe, it, expect } from "vitest";
import en from "../src/locales/en.json";
import zh from "../src/locales/zh-CN.json";

const flat = (o: Record<string, unknown>, p = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === "object" ? flat(v as never, `${p}${k}.`) : [`${p}${k}`]);

describe("i18n completeness (spec AC-021)", () => {
  it("zh-CN has exactly the same keys as en", () => {
    const a = flat(en).sort(), b = flat(zh).sort();
    expect(b).toEqual(a);
  });
  it("no empty values", () => {
    const leafValues = (o: Record<string, unknown>): string[] =>
      Object.values(o).flatMap((v) =>
        typeof v === "object" ? leafValues(v as Record<string, unknown>) : [v as string]);
    const vals = [...leafValues(en), ...leafValues(zh)];
    expect(vals.length).toBeGreaterThan(0);
    expect(vals.every((s) => s.length > 0)).toBe(true);
  });
});
