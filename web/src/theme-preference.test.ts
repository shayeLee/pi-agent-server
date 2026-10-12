import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readThemeMode, resolveTheme, themePreferenceKey, writeThemeMode } from "./theme-preference.js";

describe("theme preference", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it.each(["light", "dark", "system"] as const)("stores and restores the selected %s mode", mode => {
    writeThemeMode(mode);
    expect(localStorage.getItem(themePreferenceKey())).toBe(mode);
    expect(readThemeMode()).toBe(mode);
  });

  it.each([null, "", "invalid", "LIGHT", '"dark"'])("defaults to system for %s", value => {
    if (value !== null) localStorage.setItem(themePreferenceKey(), value);
    expect(readThemeMode()).toBe("system");
  });

  it("falls back when storage reads throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readThemeMode()).toBe("system");
  });

  it("ignores storage write failures", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => writeThemeMode("dark")).not.toThrow();
  });

  it("handles a denied localStorage getter", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("denied"); });
    expect(readThemeMode()).toBe("system");
    expect(() => writeThemeMode("light")).not.toThrow();
  });

  it.each([false, true])("resolves system using current OS preference (%s), not manual modes", matches => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches }) });
    try {
      expect(resolveTheme("system")).toBe(matches ? "dark" : "light");
      expect(resolveTheme("light")).toBe("light");
      expect(resolveTheme("dark")).toBe("dark");
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });
});
