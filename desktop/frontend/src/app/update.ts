import { useEffect, useRef } from "react";
import { Browser, Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { useTranslation } from "./i18n";

/**
 * Wire shape of the Go payload (internal/version/version.go UpdateInfo) of
 * the "update:available" event emitted by the startup update check.
 */
export interface UpdateInfoWire {
  current?: unknown;
  latest?: unknown;
  url?: unknown;
  has_update?: unknown;
}

function parseUpdate(data: unknown): { latest: string; url: string } | null {
  const d = (data ?? {}) as UpdateInfoWire;
  const latest = typeof d.latest === "string" ? d.latest : "";
  const url = typeof d.url === "string" ? d.url : "";
  if (!latest) return null;
  return { latest, url };
}

/**
 * Subscribes to the backend "update:available" event and shows a dismissible
 * toast whose action opens the release page in the system browser
 * (Browser.OpenURL — available in @wailsio/runtime; window.open would hit
 * popup blockers). A ref guards against duplicate events: at most one toast
 * per app run, even if the backend emits twice.
 */
export function useUpdateNotice(): void {
  const { t } = useTranslation();
  const shown = useRef(false);

  useEffect(() => {
    const off = Events.On("update:available", (e) => {
      if (shown.current) return;
      const info = parseUpdate(e.data);
      if (!info) return;
      shown.current = true;
      toast.message(t("update.available", { version: info.latest }), {
        description: info.url || undefined,
        duration: 10000,
        closeButton: true,
        action: info.url
          ? {
              label: t("update.download"),
              onClick: () => void Browser.OpenURL(info.url),
            }
          : undefined,
      });
    });
    return () => {
      off();
    };
  }, [t]);
}
