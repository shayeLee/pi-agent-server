import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { zhCN, type MessageKey, type Messages } from "./zh-CN.js";
import { en } from "./en.js";

export type Locale = "zh-CN" | "en";
export type { MessageKey };
export type TranslateParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

export const DEFAULT_LOCALE: Locale = "zh-CN";
export const LOCALES: readonly Locale[] = ["zh-CN", "en"];
const tables: Record<Locale, Messages> = { "zh-CN": zhCN, en };

/** Missing placeholders are left verbatim so a gap is visible rather than silently blank. */
export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const template = tables[locale][key] ?? zhCN[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}

type I18nValue = { locale: Locale; setLocale: (locale: Locale) => void; t: Translate };

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key, params) => translate(DEFAULT_LOCALE, key, params),
});

export function I18nProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useCallback<Translate>((key, params) => translate(locale, key, params), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Works without a provider (zh-CN), so components and tests need no wrapper. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}
