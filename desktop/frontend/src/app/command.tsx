import { Command } from "cmdk";
import { useTranslation } from "./i18n";
import { NAV_ICONS, PAGES, type PageId } from "./shell";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (p: PageId) => void;
  /** Context names available for switching (Task 10 wires ListContexts). */
  contexts: string[];
  /** Invoked when the user picks a context (Task 10: Connect). */
  onSwitchContext: (name: string) => void;
}

/**
 * Global command palette (Ctrl/Cmd+K; the hotkey listener is mounted by
 * App.tsx). Groups: "Go to" with the eight pages and "Connections" with the
 * switchable contexts.
 */
export function CommandPalette({
  open,
  onClose,
  onNavigate,
  contexts,
  onSwitchContext,
}: CommandPaletteProps) {
  const { t } = useTranslation();

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      label={t("palette.placeholder")}
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      contentClassName="fixed top-[20%] left-1/2 z-50 w-[420px] max-w-[calc(100%-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--fg-faint)]"
    >
      <Command.Input
        placeholder={t("palette.placeholder")}
        className="h-10 w-full border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-[var(--fg-faint)]"
      />
      <Command.List className="max-h-72 overflow-y-auto p-1 text-sm">
        <Command.Empty className="px-3 py-6 text-center text-[var(--fg-muted)]">
          {t("palette.noResults")}
        </Command.Empty>

        <Command.Group heading={t("palette.groupNavigation")}>
          {PAGES.map((id) => {
            const Icon = NAV_ICONS[id];
            return (
              <Command.Item
                key={id}
                data-testid={`cmd-${id}`}
                value={`${t(`nav.${id}`)} ${id}`}
                onSelect={() => onNavigate(id)}
                className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 outline-none select-none data-[selected=true]:bg-[var(--border-soft)] data-[selected=true]:text-foreground"
              >
                <Icon size={16} strokeWidth={1.75} className="shrink-0 text-[var(--fg-muted)]" />
                {t(`nav.${id}`)}
              </Command.Item>
            );
          })}
        </Command.Group>

        <Command.Group heading={t("palette.groupConnections")}>
          {contexts.length === 0 ? (
            // Task 10 wires ListContexts; nothing switchable yet.
            <div className="px-2 py-1.5 text-[var(--fg-faint)]">{t("palette.noContexts")}</div>
          ) : (
            contexts.map((name) => (
              <Command.Item
                key={name}
                data-testid={`cmd-ctx-${name}`}
                value={`${t("palette.groupConnections")} ${name}`}
                onSelect={() => onSwitchContext(name)}
                className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 outline-none select-none data-[selected=true]:bg-[var(--border-soft)] data-[selected=true]:text-foreground"
              >
                <span className="size-2 shrink-0 rounded-full bg-[var(--fg-faint)]" aria-hidden="true" />
                {name}
              </Command.Item>
            ))
          )}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
