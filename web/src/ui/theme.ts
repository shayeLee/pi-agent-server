import { useCallback, useEffect, useRef, useState } from "react";

export type ColorScheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Follows the system color scheme until the user toggles it in this page session,
 * and mirrors the choice to `<html data-theme>` so tokens and portals inherit it.
 */
export function useColorScheme() {
  const [theme, setTheme] = useState<ColorScheme>(() =>
    window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light",
  );
  const overridden = useRef(false);
  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY);
    if (!media) return;
    const sync = (event: MediaQueryListEvent) => {
      if (!overridden.current) setTheme(event.matches ? "dark" : "light");
    };
    if (media.addEventListener) {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }
    if (media.addListener) {
      media.addListener(sync);
      return () => media.removeListener(sync);
    }
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const toggleTheme = useCallback(() => {
    overridden.current = true;
    setTheme((current) => current === "dark" ? "light" : "dark");
  }, []);
  return { theme, toggleTheme };
}
