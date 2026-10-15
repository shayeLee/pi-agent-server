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
/** Every model call of the current host prompt, summed; a field is null once any call lacks it. */
export type PromptUsage = UsageTokens & { calls: number };
/** Child agent model calls on the current branch, summed per completed assistant message. */
export type SubagentUsage = UsageTokens & { runs: number; calls: number };
export type UsageSnapshot = {
  /** Authoritative session counts; absent on older servers. Partial history never supplies fake totals. */
  execution?: ExecutionSnapshot | null;
  lastResponse?: LastResponseUsage | null;
  sessionTotals?: (UsageTokens & { scope: "allEntries" }) | null;
  context?: { tokens: number | null; window: number | null; percent: number | null; estimate: true } | null;
  /** Absent on older servers; null when no prompt ran in this process (e.g. after a restart). */
  currentPrompt?: PromptUsage | null;
  /** Not included in sessionTotals; null when the branch has no child agent runs. */
  subagentTotals?: SubagentUsage | null;
};

export const EMPTY_USAGE_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsdEstimate: 0 };
/** Field-wise sum; unknown stays unknown rather than counting as zero. */
export function addUsageTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  const add = (x: number | null, y: number | null) => x === null || y === null ? null : x + y;
  return { input: add(a.input, b.input), output: add(a.output, b.output), cacheRead: add(a.cacheRead, b.cacheRead),
    cacheWrite: add(a.cacheWrite, b.cacheWrite), totalTokens: add(a.totalTokens, b.totalTokens), costUsdEstimate: add(a.costUsdEstimate, b.costUsdEstimate) };
}
/** SDK `Usage` (or a stored copy of it) as public token fields. */
export function usageTokensOf(usage: unknown): UsageTokens {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  const cost = (u.cost && typeof u.cost === "object" ? u.cost : {}) as Record<string, unknown>;
  return { input: nonnegative(u.input), output: nonnegative(u.output), cacheRead: nonnegative(u.cacheRead),
    cacheWrite: nonnegative(u.cacheWrite), totalTokens: nonnegative(u.totalTokens), costUsdEstimate: nonnegative(cost.total) };
}

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
