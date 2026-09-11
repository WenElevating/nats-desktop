import { useCallback, useEffect, useState } from "react";
import { Events, System } from "@wailsio/runtime";
import { PlugZap, Plus } from "lucide-react";
import { toast } from "sonner";
import { applyTheme, ThemeMode } from "./app/theme";
import { setLanguage, useTranslation } from "./app/i18n";
import { Shell, type PageId } from "./app/shell";
import { ConnStateProvider, useConnState } from "./app/connstate";
import { CommandPalette } from "./app/command";
import { SettingsPage } from "./features/settings/SettingsPage";
import { ConnectionsPage } from "./features/connections/ConnectionsPage";
import { Connect, Default, GetSettings, ListContexts, SaveSettings } from "./lib/bindings";
import type { Settings } from "./lib/bindings";
import { Button } from "@/components/ui/button";
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

/**
 * First-run guidance view (AC-001): with no stored context the shell's main
 * area shows this card instead of the plain empty state. The CTA jumps to
 * Settings > Connections and opens the create dialog (createSignal seam).
 */
function FirstRunGuide({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="first-run-guide"
      className="flex flex-1 flex-col items-center justify-center p-8"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-panel p-8 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-[var(--accent-soft)]">
          <PlugZap size={20} strokeWidth={1.75} className="text-[var(--accent-strong)]" aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold">NATS Desktop</h2>
        <p className="text-sm text-[var(--fg-muted)]">{t("guide.title")}</p>
        <p className="text-xs text-[var(--fg-faint)]">{t("guide.body")}</p>
        <Button size="sm" className="mt-2" data-testid="guide-create" onClick={onCreate}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          {t("connections.new")}
        </Button>
      </div>
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
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings>(Default());
  const [page, setPage] = useState<PageId>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Settings hosts two tabs: the general form and connection management.
  const [settingsTab, setSettingsTab] = useState<"general" | "connections">("general");
  // Known context names for the sidebar switcher and the command palette;
  // refreshed on mount and after every connection mutation. null = the first
  // ListContexts has not answered yet (guards the first-run guide against a
  // flash on every startup).
  const [contexts, setContexts] = useState<string[] | null>(null);
  // Host-driven create-dialog request (first-run guide CTA): each pulse opens
  // the create dialog on the connections tab exactly once.
  const [createSignal, setCreateSignal] = useState(0);
  const conn = useConnState();

  const refreshContexts = useCallback(async () => {
    try {
      const list = await ListContexts();
      setContexts((list ?? []).map((c) => c.name));
    } catch (err) {
      console.error("list contexts failed:", err);
      setContexts([]);
    }
  }, []);

  useEffect(() => {
    void refreshContexts();
  }, [refreshContexts]);

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

  // Switch the live connection to the named context; progress and failures
  // surface through conn:state events (banner / footer). An immediate
  // rejection (e.g. context unloadable) toasts (spec §18.5).
  const switchContext = (name: string) => {
    Connect(name).catch((err) => {
      console.error("connect failed:", err);
      toast.error(t("connections.connectFailed", { error: err instanceof Error ? err.message : String(err) }));
    });
  };

  // First run = the initial listing answered with zero contexts (AC-001):
  // the guide card replaces the per-page empty state.
  const firstRun = contexts !== null && contexts.length === 0;

  // Land on Settings > Connections (shared by the fix-connection actions and
  // the first-run guide CTA).
  const gotoConnections = () => {
    setPage("settings");
    setSettingsTab("connections");
  };

  // Guide CTA: land on Settings > Connections and pulse the create signal so
  // the page opens the create dialog (whether it mounts fresh or is already
  // mounted).
  const openCreateContext = () => {
    gotoConnections();
    setCreateSignal((n) => n + 1);
  };

  return (
    <>
      <Shell
        page={page}
        onNavigate={setPage}
        conn={conn}
        contexts={contexts ?? []}
        onSwitchContext={switchContext}
        guide={firstRun ? <FirstRunGuide onCreate={openCreateContext} /> : undefined}
        onFixConnection={gotoConnections}
      >
        {page === "settings" ? (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="settings-tabs">
            <div role="tablist" aria-label={t("settings.title")} className="flex gap-1 border-b border-border px-4 pt-2">
              {(["general", "connections"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === tab}
                  data-testid={`settings-tab-${tab}`}
                  onClick={() => setSettingsTab(tab)}
                  className={`rounded-t-md px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                    settingsTab === tab
                      ? "border-b-2 border-[var(--accent)] font-medium text-foreground"
                      : "border-b-2 border-transparent text-[var(--fg-muted)] hover:text-foreground"
                  }`}
                >
                  {t(tab === "general" ? "settings.tabGeneral" : "settings.tabConnections")}
                </button>
              ))}
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {settingsTab === "general" ? (
                <SettingsPage settings={settings} onSave={handleSave} />
              ) : (
                <ConnectionsPage
                  activeContext={conn.context}
                  onChanged={refreshContexts}
                  createSignal={createSignal}
                  onCreateSignalConsumed={() => setCreateSignal(0)}
                />
              )}
            </div>
          </div>
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
        contexts={contexts ?? []}
        onSwitchContext={switchContext}
      />
      <Toaster theme={isDark ? "dark" : "light"} position="bottom-right" />
    </>
  );
}

export default App
