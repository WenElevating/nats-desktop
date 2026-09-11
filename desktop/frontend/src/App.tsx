import { useEffect, useState } from "react";
import { Events, System } from "@wailsio/runtime";
import { applyTheme, ThemeMode } from "./app/theme";
import { setLanguage, useTranslation } from "./app/i18n";
import { Shell, type PageId } from "./app/shell";
import { ConnStateProvider, useConnState } from "./app/connstate";
import { CommandPalette } from "./app/command";
import { SettingsPage } from "./features/settings/SettingsPage";
import { Default, GetSettings, SaveSettings } from "./lib/bindings";
import type { Settings } from "./lib/bindings";
import { Toaster } from "@/components/ui/sonner";

const isThemeMode = (v: string): v is ThemeMode =>
  v === "light" || v === "dark" || v === "system";

/** Returns the resolved dark flag so hosts (e.g. the Toaster) can follow it. */
export function useThemeController(mode: ThemeMode): boolean {
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
  const dark = mode === "dark" || (mode === "system" && systemDark);
  useEffect(() => applyTheme(mode, systemDark), [mode, systemDark]);
  return dark;
}

/**
 * Placeholder for the pages landing in M2–M5 (Dashboard, Messages, Streams,
 * Consumers, KV, Objects, Monitoring). Only rendered while connected; the
 * Shell swaps in its own guidance state otherwise.
 */
function PagePlaceholder({ page }: { page: PageId }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`page-${page}`}
      className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <h2 className="text-lg font-medium">{t(`nav.${page}`)}</h2>
      <p className="text-sm text-[var(--fg-muted)]">{t("common.comingSoon")}</p>
    </div>
  );
}

function App() {
  return (
    <ConnStateProvider>
      <AppBody />
    </ConnStateProvider>
  );
}

function AppBody() {
  const [settings, setSettings] = useState<Settings>(Default());
  const [page, setPage] = useState<PageId>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Task 10 seam: ListContexts() hydration and the Connect binding. The
  // switcher/palette render an empty (disabled) list until then.
  const [contexts] = useState<string[]>([]);
  const conn = useConnState();

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
  const isDark = useThemeController(theme);

  // Global Ctrl/Cmd+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Persist, then re-apply language (and theme via state) so changes take
  // effect immediately (spec §6.12).
  const handleSave = async (s: Settings) => {
    await SaveSettings(s);
    setSettings(s);
    setLanguage(s.appearance.language);
  };

  // Task 10 wires the Connect binding for context switching.
  const switchContext = (name: string) => {
    void name;
  };

  return (
    <>
      <Shell
        page={page}
        onNavigate={setPage}
        conn={conn}
        contexts={contexts}
        onSwitchContext={switchContext}
      >
        {page === "settings" ? (
          <SettingsPage settings={settings} onSave={handleSave} />
        ) : (
          <PagePlaceholder page={page} />
        )}
      </Shell>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(p) => {
          setPage(p);
          setPaletteOpen(false);
        }}
        contexts={contexts}
        onSwitchContext={switchContext}
      />
      <Toaster theme={isDark ? "dark" : "light"} position="bottom-right" />
    </>
  );
}

export default App
