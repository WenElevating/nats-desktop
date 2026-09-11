export type ThemeMode = "light" | "dark" | "system";

export function applyTheme(mode: ThemeMode, systemDark: boolean): void {
  if (mode !== "light" && mode !== "dark" && mode !== "system") {
    throw new Error(`Unknown theme mode: ${String(mode)}`);
  }
  const dark = mode === "dark" || (mode === "system" && systemDark);
  document.documentElement.classList.toggle("dark", dark);
}
