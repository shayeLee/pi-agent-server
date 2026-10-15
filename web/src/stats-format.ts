import { formatExact } from "./i18n/format.js";

export function validMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function rawMetric(value: number): string {
  // String preserves the protocol number, including very small USD estimates.
  return Number.isInteger(value) ? formatExact(value) : String(value);
}
/** Share of prompt tokens served from cache: read / (input + read + write). */
export function cacheShare(input: number | null | undefined, read: number | null | undefined, write: number | null | undefined): number | null {
  if (!validMetric(input) || !validMetric(read) || !validMetric(write)) return null;
  const denominator = input + read + write;
  return denominator > 0 ? read / denominator * 100 : null;
}
