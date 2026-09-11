import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import zh from "../locales/zh-CN.json";

export const LANGUAGES = ["en", "zh-CN"] as const;

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, "zh-CN": { translation: zh } },
  lng: "en", fallbackLng: "en", interpolation: { escapeValue: false },
});

export function setLanguage(l: string): void {
  if (!(LANGUAGES as readonly string[]).includes(l)) return;
  void i18n.changeLanguage(l);
}
export default i18n;
