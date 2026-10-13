/** Presentation only: never infer elapsed time from lifecycle or timestamps. */
export function formatToolDuration(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value === 0) return "0ms";
  if (value < 1) return "<1ms";
  if (value < 1000) return `${Math.floor(value)}ms`;
  // Round once before splitting, so boundaries never produce “1m 60s”.
  const tenths = Math.round(value / 100);
  if (tenths < 600) return `${tenths / 10}s`;
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}
