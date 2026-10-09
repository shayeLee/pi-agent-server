/** Only SDK execution measurements are accepted; absent historical values stay absent. */
export function toolDurationMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
