import { describe, it, expect, beforeEach } from "vitest";
import { applyTheme, type ThemeMode } from "../src/app/theme";

describe("applyTheme", () => {
  beforeEach(() => document.documentElement.className = "");

  it("light mode removes .dark", () => {
    document.documentElement.classList.add("dark");
    applyTheme("light", true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("dark mode adds .dark", () => {
    applyTheme("dark", false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("system mode follows system darkness", () => {
    applyTheme("system", true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("system", false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("rejects unknown mode", () => {
    expect(() => applyTheme("sepia" as ThemeMode, false)).toThrow();
  });
});
