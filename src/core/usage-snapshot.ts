/** Additive public measurements. Null means unknown; zero is a measured SDK value. */
export type UsageTokens = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  costUsdEstimate: number | null;
};
export type LastResponseUsage = UsageTokens & {
  /** One-based assistant ordinal within this host prompt, including retries/tool loops. */
  ordinal: number | null;
  cacheHitPercent: number | null;
  speed: {
    outputTokens: number | null;
    generationDurationMs: number | null;
    tokensPerSecond: number | null;
  };
};
export type ExecutionSnapshot = {
  scope: "allEntries";
  coverage: "complete" | "recorded" | "unknown";
  totalLoops: number | null;
  totalTurns: number | null;
  recordedLoops: number | null;
  recordedTurns: number | null;
};
export type UsageSnapshot = {
  /** Authoritative session counts; absent on older servers. Partial history never supplies fake totals. */
  execution?: ExecutionSnapshot | null;
  lastResponse?: LastResponseUsage | null;
  sessionTotals?: (UsageTokens & { scope: "allEntries" }) | null;
  context?: { tokens: number | null; window: number | null; percent: number | null; estimate: true } | null;
};

export function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function cacheHitPercent(input: number | null, read: number | null, write: number | null): number | null {
  if (nonnegative(input) === null || nonnegative(read) === null || nonnegative(write) === null) return null;
  if (input === null || read === null || write === null) return null;
  const denominator = input + read + write;
  return denominator > 0 && Number.isFinite(denominator) ? nonnegative(read / denominator * 100) : null;
}

/** Below this window stream delivery/clock resolution cannot yield reliable throughput. No clamping. */
export const MIN_GENERATION_DURATION_MS = 10;
export function responseSpeed(output: number | null, duration: number | null): LastResponseUsage["speed"] {
  output = nonnegative(output);
  duration = nonnegative(duration);
  return {
    outputTokens: output,
    generationDurationMs: duration,
    tokensPerSecond: output !== null && duration !== null && duration >= MIN_GENERATION_DURATION_MS
      ? nonnegative(output / duration * 1000) : null,
  };
}
