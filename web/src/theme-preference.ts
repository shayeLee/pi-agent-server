export type ThemeMode = "light" | "dark" | "system";

export function themePreferenceKey(): string {
  return `pi.theme-mode.v1:${new URL("/", window.location.href).origin}`;
}

export function readThemeMode(): ThemeMode {
  try {
    const mode = window.localStorage.getItem(themePreferenceKey());
    if (mode === "light" || mode === "dark" || mode === "system") return mode;
  } catch { /* Storage may be denied; follow the system instead. */ }
  return "system";
}

export function writeThemeMode(mode: ThemeMode): void {
  try { window.localStorage.setItem(themePreferenceKey(), mode); }
  catch { /* Theme selection still works without persistence. */ }
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
}
