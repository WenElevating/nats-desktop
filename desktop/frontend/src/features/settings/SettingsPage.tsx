import { useEffect, useState } from "react";
import { useTranslation } from "../../app/i18n";
import type { Settings } from "../../lib/bindings";
import "./SettingsPage.css";

export interface SettingsPageProps {
  settings: Settings;
  onSave(s: Settings): Promise<void>;
}

const THEME_OPTIONS = ["light", "dark", "system"] as const;
const LANGUAGE_OPTIONS = ["en", "zh-CN"] as const;
const LOG_LEVEL_OPTIONS = ["debug", "info", "warn", "error"] as const;

const toNumber = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Controlled settings form. Owns a draft copy of the settings object; Save
 * hands the whole (possibly edited) object to the parent's onSave, which is
 * responsible for persisting and re-applying theme/language (spec §6.12).
 */
export function SettingsPage({ settings, onSave }: SettingsPageProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Re-sync the draft when the parent supplies fresh settings (initial load).
  useEffect(() => setDraft(settings), [settings]);

  const patchAppearance = (patch: Partial<Settings["appearance"]>) =>
    setDraft((d) => ({ ...d, appearance: { ...d.appearance, ...patch } }));
  const patchBehavior = (patch: Partial<Settings["behavior"]>) =>
    setDraft((d) => ({ ...d, behavior: { ...d.behavior, ...patch } }));

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await onSave(draft);
      setSaved(true);
    } catch (err) {
      console.error("save settings failed:", err);
    } finally {
      setSaving(false);
    }
  };

  // OpenLogsDir binding arrives in Task 5; placeholder until then.
  const openLogs = () => console.warn("OpenLogsDir binding not available yet (Task 5)");

  return (
    <div className="settings-page">
      <h1 className="settings-title">{t("settings.title")}</h1>

      <section className="settings-section">
        <h2 className="settings-section-title">{t("settings.appearance")}</h2>
        <div className="settings-field">
          <label htmlFor="settings-theme">{t("settings.theme")}</label>
          <select
            id="settings-theme"
            value={draft.appearance.theme}
            onChange={(e) => patchAppearance({ theme: e.target.value })}
          >
            {THEME_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {t(o === "light" ? "settings.themeLight" : o === "dark" ? "settings.themeDark" : "settings.themeSystem")}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-field">
          <label htmlFor="settings-language">{t("settings.language")}</label>
          <select
            id="settings-language"
            value={draft.appearance.language}
            onChange={(e) => patchAppearance({ language: e.target.value })}
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">{t("settings.behavior")}</h2>
        <div className="settings-field">
          <label htmlFor="settings-poll">{t("settings.pollInterval")}</label>
          <input
            id="settings-poll"
            type="number"
            min={1}
            value={draft.behavior.poll_interval_seconds}
            onChange={(e) => patchBehavior({ poll_interval_seconds: toNumber(e.target.value) })}
          />
        </div>
        <div className="settings-field">
          <label htmlFor="settings-timeout">{t("settings.requestTimeout")}</label>
          <input
            id="settings-timeout"
            type="number"
            min={1}
            value={draft.behavior.request_timeout_seconds}
            onChange={(e) => patchBehavior({ request_timeout_seconds: toNumber(e.target.value) })}
          />
        </div>
        <div className="settings-field">
          <label htmlFor="settings-loglevel">{t("settings.logLevel")}</label>
          <select
            id="settings-loglevel"
            value={draft.behavior.log_level}
            onChange={(e) => patchBehavior({ log_level: e.target.value })}
          >
            {LOG_LEVEL_OPTIONS.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
        <div className="settings-field">
          <button type="button" className="settings-secondary" onClick={openLogs}>
            {t("settings.openLogs")}
          </button>
        </div>
      </section>

      <div className="settings-actions">
        <button type="button" className="settings-primary" onClick={handleSave} disabled={saving}>
          {t("common.save")}
        </button>
        {saved && (
          <span className="settings-saved" role="status">{t("settings.saved")}</span>
        )}
      </div>
    </div>
  );
}
