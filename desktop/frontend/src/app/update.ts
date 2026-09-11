import { useEffect, useRef } from "react";
import { Browser, Events } from "@wailsio/runtime";
import { toast } from "sonner";
import { CheckUpdate, GetSettings } from "../lib/bindings";
import { useTranslation } from "./i18n";

/**
 * Wire shape of the Go payload (internal/version/version.go UpdateInfo) of
 * the "update:available" event emitted by the startup update check, and of
 * the CheckUpdate() binding result.
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
 * popup blockers). As a fallback for a missed startup event (the frontend can
 * mount after the Go-side startup check already emitted), it asks the backend
 * once on mount — under the same privacy contract as that check (only when
 * the user opted in via Privacy.UpdateCheck). A once-per-run ref guarantees
 * at most one toast per app run, no matter which path fires first.
 */
export function useUpdateNotice(): void {
  const { t } = useTranslation();
  const shown = useRef(false);

  useEffect(() => {
    const show = (info: { latest: string; url: string } | null) => {
      if (shown.current || !info) return;
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
    };

    // Mount-time fallback. Silent on any failure: an unavailable update feed
    // or settings read must never disturb the app (spec §6.13).
    void (async () => {
      try {
        const s = await GetSettings();
        if (!s.privacy.update_check) return;
        const info = await CheckUpdate();
        if (info.has_update) show(parseUpdate(info));
      } catch {
        /* silent */
      }
    })();

    const off = Events.On("update:available", (e) => {
      show(parseUpdate(e.data));
    });
    return () => {
      off();
    };
  }, [t]);
}
