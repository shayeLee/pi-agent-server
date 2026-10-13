import { zhCN } from "./i18n/zh-CN.js";
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 20 });

export function validMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function formatTokens(value: number): string {
  return compact.format(value);
}
export function rawMetric(value: number): string {
  // String preserves the protocol number, including very small USD estimates.
  return Number.isInteger(value) ? exact.format(value) : String(value);
}
export function formatDuration(value: number): string {
  return value < 1000 ? zhCN.time.milliseconds(exact.format(value)) : zhCN.time.seconds(new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1000));
}
