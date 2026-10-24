// GET /v1/usage: billed model calls summed per model and per calendar day, week or month.

export type UsagePeriod = "day" | "week" | "month";

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsdEstimate: number;
  calls: number;
  subagentTokens: number;
};

export type ModelUsage = UsageTotals & { readonly provider: string; readonly model: string };
export type UsageBucket = { readonly start: string; readonly totals: UsageTotals; readonly models: ModelUsage[] };
export type UsageReport = {
  readonly period: UsagePeriod;
  readonly timeZone: string;
  readonly from: string;
  readonly to: string;
  readonly buckets: UsageBucket[];
  readonly models: ModelUsage[];
  readonly totals: UsageTotals;
  readonly sessions: number;
  readonly unreadSessions: number;
  /** The owner's butler sessions' share, already counted in `totals`; absent when there is none. */
  readonly butler?: UsageTotals;
};
