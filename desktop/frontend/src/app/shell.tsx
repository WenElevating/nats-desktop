import type { ReactNode } from "react";
import {
  Activity,
  ChevronDown,
  Database,
  LayoutDashboard,
  Loader2,
  Mail,
  Package,
  Settings,
  Unplug,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "./i18n";
import { useConnState, type ConnState } from "./connstate";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** All top-level pages, in sidebar order. */
export const PAGES = [
  "dashboard",
  "messages",
  "streams",
  "consumers",
  "kv",
  "objects",
  "monitoring",
  "settings",
] as const;

export type PageId = (typeof PAGES)[number];

// lucide icon per page, 16px / strokeWidth 1.75 (spec §18.2: svg icons only).
export const NAV_ICONS: Record<PageId, LucideIcon> = {
  dashboard: LayoutDashboard,
  messages: Mail,
  streams: Zap,
  consumers: Users,
  kv: Database,
  objects: Package,
  monitoring: Activity,
  settings: Settings,
};

/** Status dot color per connection state; default (gray) for the rest. */
function statusDotClass(state: string): string {
  switch (state) {
    case "connected":
      return "bg-[var(--ok)]";
    case "reconnecting":
      return "bg-[var(--warn)]";
    case "failed":
      return "bg-[var(--danger)]";
    default:
      return "bg-[var(--fg-faint)]";
  }
}

export interface ShellProps {
  page: PageId;
  onNavigate: (p: PageId) => void;
  children: ReactNode;
  /**
   * Explicit connection state override. When omitted the shell consumes the
   * ConnStateProvider context via useConnState (spec §18.3 banner/footer);
   * hosts without a provider get the disconnected default.
   */
  conn?: ConnState;
  /** Known context names for the switcher. Task 10 wires ListContexts. */
  contexts?: string[];
  /** Invoked when the user picks a context to switch to (Task 10: Connect). */
  onSwitchContext?: (name: string) => void;
  /** Rendered in place of the disconnected empty state on first run (no
   * contexts yet): the guide card with the "create context" CTA (AC-001). */
  guide?: ReactNode;
  /** Invoked by the banner / empty-state "Edit connection" actions. Defaults
   * to plain settings navigation; App points it at the Connections tab so
   * fix-connection lands on the context list (spec §6.2). */
  onFixConnection?: () => void;
}

/**
 * Application shell: fixed left sidebar (logo, context switcher, eight nav
 * entries, connection summary footer) and a main column (transient connection
 * banner, page content). Non-settings pages render an EmptyState while the
 * connection is not established.
 */
export function Shell({
  page,
  onNavigate,
  children,
  conn: connOverride,
  contexts = [],
  onSwitchContext,
  guide,
  onFixConnection,
}: ShellProps) {
  const { t } = useTranslation();
  // §18.3: the banner and status footer consume the live connection state
  // (conn:state events via useConnState; the context default is DISCONNECTED
  // when no provider is mounted). The hook is called unconditionally (rules
  // of hooks — it is a pure useContext, no subscription); an explicit prop
  // then wins so hosts and tests can pin a state.
  const ctxConn = useConnState();
  const conn = connOverride ?? ctxConn;
  const connected = conn.state === "connected";
  const showBanner = conn.state === "reconnecting" || conn.state === "failed";
  const bannerWarn = conn.state === "reconnecting";
  // Fix-connection action shared by the banner and the empty state: straight
  // to Settings unless the host routes it to the Connections tab.
  const fixConnection = onFixConnection ?? (() => onNavigate("settings"));

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-panel" data-testid="sidebar">
        {/* Logo row */}
        <div className="flex h-12 items-center gap-2 px-4">
          <span className="size-2.5 rounded-[4px] bg-[var(--accent)]" aria-hidden="true" />
          <span className="text-sm font-semibold tracking-wide">NATS Desktop</span>
        </div>

        {/* Context switcher */}
        <div className="px-3 pb-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between font-normal"
                data-testid="context-switcher"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`size-2 shrink-0 rounded-full ${statusDotClass(conn.state)}`} aria-hidden="true" />
                  <span className="truncate">{conn.context || t("conn.disconnected")}</span>
                </span>
                <ChevronDown size={14} strokeWidth={1.75} className="shrink-0 text-[var(--fg-muted)]" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>{t("conn.switchContext")}</DropdownMenuLabel>
              {contexts.length === 0 ? (
                // Task 10 wires ListContexts; until then only the (inert)
                // current context name is listed and items stay disabled.
                <DropdownMenuItem disabled>
                  {conn.context || t("conn.disconnected")}
                </DropdownMenuItem>
              ) : (
                contexts.map((name) => (
                  <DropdownMenuItem key={name} disabled={!onSwitchContext} onSelect={() => onSwitchContext?.(name)}>
                    <span className={`size-2 rounded-full ${name === conn.context ? statusDotClass(conn.state) : "bg-[var(--fg-faint)]"}`} aria-hidden="true" />
                    {name}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Navigation */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2" aria-label={t("nav.label")}>
          {PAGES.map((id) => {
            const Icon = NAV_ICONS[id];
            const active = page === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`nav-${id}`}
                aria-current={active ? "page" : undefined}
                onClick={() => onNavigate(id)}
                className={`flex h-9 items-center gap-2.5 rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                  active
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                    : "text-[var(--fg-muted)] hover:bg-[var(--border-soft)] hover:text-foreground"
                }`}
              >
                <Icon size={16} strokeWidth={1.75} className="shrink-0" />
                {t(`nav.${id}`)}
              </button>
            );
          })}
        </nav>

        {/* Connection summary footer: state indicator + context + RTT.
            §18.3: connecting shows a spinner; the other states a color dot
            (green connected / amber reconnecting / red failed / gray rest). */}
        <div className="border-t border-border px-4 py-2.5 text-xs text-[var(--fg-muted)]" data-testid="conn-summary">
          <span className="flex items-center gap-1.5">
            {conn.state === "connecting" ? (
              <Loader2 size={12} strokeWidth={1.75} className="shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <span className={`size-1.5 shrink-0 rounded-full ${statusDotClass(conn.state)}`} aria-hidden="true" />
            )}
            {t(`conn.${conn.state}`)}
          </span>
          <span className="mt-1 block truncate text-[var(--fg-faint)]">
            {conn.context || t("conn.disconnected")}
            {connected && conn.rttMs > 0 ? ` · ${conn.rttMs}ms` : ""}
          </span>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {showBanner && (
          <div
            data-testid="conn-banner"
            role="status"
            className={`flex h-10 shrink-0 items-center justify-between gap-3 px-4 text-sm ${
              bannerWarn
                ? "bg-[var(--warn-soft)] text-[var(--warn-fg)]"
                : "bg-[var(--danger-soft)] text-[var(--danger-fg)]"
            }`}
          >
            <span className="truncate">
              {bannerWarn
                ? t("conn.bannerReconnecting")
                : t("conn.bannerFailed", { reason: conn.reason })}
            </span>
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              data-testid="conn-fix"
              onClick={fixConnection}
            >
              {t("conn.fixConnection")}
            </Button>
          </div>
        )}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {page !== "settings" && !connected ? (
            // First run (no contexts yet) shows the guide card instead of
            // the plain empty state (AC-001); the sidebar stays usable.
            guide ?? <EmptyState page={page} onFix={fixConnection} />
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}

/** Placeholder shown on data pages while no connection is established
 * (§18.3 disconnected: "choose or create a connection" guidance card). */
function EmptyState({ page, onFix }: { page: PageId; onFix: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="empty-state"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <Unplug size={28} strokeWidth={1.75} className="text-[var(--fg-faint)]" />
      <h2 className="text-lg font-medium">{t(`nav.${page}`)}</h2>
      <p className="text-sm text-[var(--fg-muted)]">{t("conn.chooseOrCreate")}</p>
      <p className="text-xs text-[var(--fg-faint)]">{t("common.comingSoon")}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onFix}>
        {t("conn.fixConnection")}
      </Button>
    </div>
  );
}
