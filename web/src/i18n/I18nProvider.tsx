import { createContext, useContext, useMemo, type ReactNode } from "react";
import { catalogs, detectLocale, t, type Locale, type MessageKey } from "./messages.js";

type I18nContextValue = {
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, locale }: { children: ReactNode; locale?: Locale }) {
  const value = useMemo<I18nContextValue>(() => {
    const resolved = locale ?? detectLocale();
    return {
      locale: resolved,
      t: (key: MessageKey, vars?: Record<string, string>) => t(resolved, key, vars),
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    const locale = detectLocale();
    return { locale, t: (key, vars) => t(locale, key, vars) };
  }
  return ctx;
}

export { catalogs };
