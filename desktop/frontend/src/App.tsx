import { useEffect, useState } from "react";
import { Events, System } from "@wailsio/runtime";
import { applyTheme, ThemeMode } from "./app/theme";
import { setLanguage } from "./app/i18n";
import { SettingsPage } from "./features/settings/SettingsPage";
import { Default, GetSettings, SaveSettings } from "./lib/bindings";
import type { Settings } from "./lib/bindings";

const isThemeMode = (v: string): v is ThemeMode =>
  v === "light" || v === "dark" || v === "system";

export function useThemeController(mode: ThemeMode) {
  // Synchronous best guess before the runtime answers, so a dark system does
  // not flash light-themed on first paint. Refined once IsDarkMode resolves.
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    let alive = true;
    System.IsDarkMode()
      .then((d) => alive && setSystemDark(Boolean(d)))
      .catch(() => {
        /* no answer outside Wails (plain browser) — keep the matchMedia guess */
      });
    const off = Events.On("common:ThemeChanged", (e) =>
      setSystemDark(Boolean(e.data)),
    );
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => applyTheme(mode, systemDark), [mode, systemDark]);
}

function App() {
  const [settings, setSettings] = useState<Settings>(Default());

  // Load persisted settings once, then apply language (theme flows through
  // the controller below).
  useEffect(() => {
    let alive = true;
    GetSettings()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setLanguage(s.appearance.language);
      })
      .catch(console.error);
    return () => { alive = false; };
  }, []);

  const theme = isThemeMode(settings.appearance.theme)
    ? settings.appearance.theme
    : "system";
  useThemeController(theme);

  // Persist, then re-apply language (and theme via state) so changes take
  // effect immediately (spec §6.12).
  const handleSave = async (s: Settings) => {
    await SaveSettings(s);
    setSettings(s);
    setLanguage(s.appearance.language);
  };

  return (
    <main>
      <SettingsPage settings={settings} onSave={handleSave} />
    </main>
  );
}

export default App
