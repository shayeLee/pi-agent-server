import { zhCN } from "./zh-CN.js";

/**
 * The only place that formats numbers, dates and units for display. Every formatter is built
 * from the language object's locale, so a second language changes "1.3万" to "13K" with no
 * call site touched. `src/i18n-format.test.ts` keeps `Intl` and `toLocale*` out of other files.
 */
const { locale, units } = zhCN;
const formats = new Map<string, Intl.NumberFormat>();
function number(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let format = formats.get(key);
  if (!format) formats.set(key, format = new Intl.NumberFormat(locale, options));
  return format;
}

/** Counts and token amounts: whole below ten thousand, then abbreviated the locale's way to three significant digits (`4403`, `1.3万`, `6460万`). */
export function formatCompact(value: number): string {
  return value < 10_000 ? number({ maximumFractionDigits: 0, useGrouping: false }).format(value)
    : number({ notation: "compact", maximumSignificantDigits: 3 }).format(value);
}
/** Every digit, with the locale's grouping (`2,345,678`). */
export function formatExact(value: number): string {
  return number({ maximumFractionDigits: 20 }).format(value);
}
/** `value` is already a percentage (0–100): two significant digits below 10%, whole numbers above. */
export function formatPercent(value: number): string {
  return number({ style: "percent", ...(value > 0 && value < 10 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 0 }) }).format(value / 100);
}
/** SDK cost estimates are USD; small amounts keep two significant digits. */
export function formatUsd(value: number): string {
  return number({ style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
    ...(value >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumSignificantDigits: 2 }) }).format(value);
}
export function formatTokens(value: number): string {
  return units.tokens(formatCompact(value));
}
export function formatSpeed(value: number, live = false): string {
  const text = formatCompact(Math.round(value));
  return live ? units.liveSpeed(text) : units.speed(text);
}
/** Spelled-out duration for details (`345 毫秒`, `12.5 秒`). */
export function formatDuration(ms: number): string {
  return ms < 1000 ? zhCN.time.milliseconds(formatExact(ms)) : zhCN.time.seconds(number({ maximumFractionDigits: 1 }).format(ms / 1000));
}
/** Compact span for ledger meta and badges (`850ms`, `15s`, `2m05s`, `1h03m`). */
export function formatSpan(ms: number): string {
  const { ms: msUnit, s, m, h } = units.span;
  if (ms < 1000) return `${Math.round(ms)}${msUnit}`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}${s}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${m}${String(seconds % 60).padStart(2, "0")}${s}`;
  return `${Math.floor(minutes / 60)}${h}${String(minutes % 60).padStart(2, "0")}${m}`;
}
/** Full local date and time, 24-hour (tooltips). */
export function formatDateTime(date: Date | number): string {
  return new Date(date).toLocaleString(locale, { hour12: false });
}
/** Local time of day, 24-hour. */
export function formatTime(date: Date | number): string {
  return new Date(date).toLocaleTimeString(locale, { hour12: false });
}

/** The browser's IANA time zone, for server-side calendar grouping. */
export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
/** Today in the browser's zone as YYYY-MM-DD. */
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** A calendar day (YYYY-MM-DD) read as itself, whatever the zone. */
const calendarDay = (day: string) => new Date(`${day}T12:00:00Z`);
/** Axis label of a usage period starting on `start`: `10/22`, `10/20 周` or `2026年10月`. */
export function formatUsagePeriod(start: string, period: "day" | "week" | "month", long = false): string {
  const date = calendarDay(start);
  if (period === "month") return date.toLocaleDateString(locale, { timeZone: "UTC", year: long ? "numeric" : undefined, month: long ? "long" : "short" });
  const day = date.toLocaleDateString(locale, { timeZone: "UTC", year: long ? "numeric" : undefined, month: "numeric", day: "numeric" });
  return period === "week" ? zhCN.usage.weekOf(day) : day;
}
