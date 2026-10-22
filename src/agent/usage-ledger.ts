// Every billed model call recorded in one session file, with its time and model, so usage can be
// summed per day, week or month across sessions. Counts the whole file (abandoned branches were
// billed too) and child-agent calls stored in the parent's transcript.

import { SUBAGENT_TRANSCRIPT } from "../shared/subagents.js";
import type { ModelUsage, UsagePeriod, UsageReport, UsageTotals } from "../shared/usage-report.js";
export type { ModelUsage, UsageBucket, UsagePeriod, UsageReport, UsageTotals } from "../shared/usage-report.js";

/** One billed call. `ts` is epoch milliseconds. */
export type UsageLedgerEvent = {
  readonly ts: number;
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly subagent: boolean;
};

export const UNKNOWN_MODEL = "unknown";

type Raw = Record<string, unknown>;
const object = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

function time(...candidates: unknown[]): number | null {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function event(usage: unknown, ts: number | null, provider: string | null, model: string | null, subagent: boolean): UsageLedgerEvent | null {
  if (!object(usage) || ts === null) return null;
  const cost = object(usage.cost) ? count(usage.cost.total) : 0;
  const result = { ts, provider: provider ?? UNKNOWN_MODEL, model: model ?? UNKNOWN_MODEL, input: count(usage.input), output: count(usage.output),
    cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), cost, subagent };
  return result.input + result.output + result.cacheRead + result.cacheWrite + result.cost > 0 ? result : null;
}

/**
 * The billed calls of one session file, in file order. Usage without its own model (compaction and
 * branch summaries, tool results) goes to the model the session was on when it was written.
 */
export function usageLedger(entries: readonly unknown[]): UsageLedgerEvent[] {
  const events: UsageLedgerEvent[] = [];
  // A child-agent message may be rewritten while it streams; only its last complete version counts.
  const childCalls = new Map<string, UsageLedgerEvent | null>();
  let provider: string | null = null;
  let model: string | null = null;
  const push = (value: UsageLedgerEvent | null) => { if (value) events.push(value); };
  for (const entry of entries) {
    if (!object(entry)) continue;
    switch (entry.type) {
      case "model_change":
        provider = text(entry.provider) ?? provider;
        model = text(entry.modelId) ?? model;
        break;
      case "usage":
        push(event(entry.usage, time(entry.timestamp), text(entry.provider) ?? provider, text(entry.model) ?? model, false));
        break;
      case "compaction":
      case "branch_summary":
        push(event(entry.usage, time(entry.timestamp), provider, model, false));
        break;
      case "message": {
        const message = entry.message;
        if (!object(message)) break;
        if (message.role === "assistant") {
          provider = text(message.provider) ?? provider;
          model = text(message.model) ?? model;
          push(event(message.usage, time(message.timestamp, entry.timestamp), provider, model, false));
        } else if (message.role === "toolResult") {
          push(event(message.usage, time(message.timestamp, entry.timestamp), provider, model, false));
        }
        break;
      }
      case "custom": {
        if (entry.customType !== SUBAGENT_TRANSCRIPT || !object(entry.data)) break;
        const data = entry.data;
        if (data.version !== 1 || typeof data.id !== "string" || data.kind !== "message" || !object(data.payload)) break;
        const message = data.payload.message;
        const key = `${data.id}\u0000${String(data.payload.key)}`;
        childCalls.delete(key);
        if (data.payload.complete === true && object(message) && message.role === "assistant") {
          childCalls.set(key, event(message.usage, time(message.timestamp, data.timestamp, entry.timestamp), text(message.provider), text(message.model), true));
        }
        break;
      }
    }
  }
  for (const call of childCalls.values()) push(call);
  return events;
}

const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsdEstimate: 0, calls: 0, subagentTokens: 0 });

function add(totals: UsageTotals, call: UsageLedgerEvent): void {
  const tokens = call.input + call.output + call.cacheRead + call.cacheWrite;
  totals.input += call.input; totals.output += call.output; totals.cacheRead += call.cacheRead; totals.cacheWrite += call.cacheWrite;
  totals.totalTokens += tokens; totals.costUsdEstimate += call.cost; totals.calls += 1;
  if (call.subagent) totals.subagentTokens += tokens;
}

/** Whether `timeZone` is a zone this runtime can format dates in. */
export function validTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The bucket a calendar day (YYYY-MM-DD) belongs to: the day, the Monday of its week, or the first of its month. */
export function bucketStart(day: string, period: UsagePeriod): string {
  if (period === "day") return day;
  if (period === "month") return `${day.slice(0, 7)}-01`;
  const ms = dayNumber(day);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return isoDay(ms - weekday * DAY_MS);
}

/** Every bucket start from `from` to `to`, both calendar days, in order; stops once past `limit` starts. */
export function bucketStarts(from: string, to: string, period: UsagePeriod, limit = Infinity): string[] {
  const starts: string[] = [];
  let day = bucketStart(from, period);
  while (day <= to && starts.length <= limit) {
    starts.push(day);
    if (period === "day") day = isoDay(dayNumber(day) + DAY_MS);
    else if (period === "week") day = isoDay(dayNumber(day) + 7 * DAY_MS);
    else {
      const date = new Date(dayNumber(day));
      date.setUTCMonth(date.getUTCMonth() + 1);
      day = isoDay(date.getTime());
    }
  }
  return starts;
}

/** Calendar day (YYYY-MM-DD) of an instant in a time zone. Every real zone offset is a multiple of 15 minutes. */
export function localDayOf(timeZone: string): (ts: number) => string {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const memo = new Map<number, string>();
  return ts => {
    const slot = Math.floor(ts / 900_000);
    let day = memo.get(slot);
    if (day === undefined) {
      const parts = Object.fromEntries(format.formatToParts(new Date(slot * 900_000)).map(part => [part.type, part.value]));
      day = `${parts.year}-${parts.month}-${parts.day}`;
      memo.set(slot, day);
    }
    return day;
  };
}

const byTokens = (a: ModelUsage, b: ModelUsage) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);

/** Sum calls into buckets of the period, per model, for calendar days `from`..`to` in `timeZone`. */
export function summarizeUsage(
  ledgers: Iterable<readonly UsageLedgerEvent[]>,
  options: { period: UsagePeriod; timeZone: string; from: string; to: string; sessions: number; unreadSessions: number },
): UsageReport {
  const { period, timeZone, from, to } = options;
  const dayOf = localDayOf(timeZone);
  const buckets = new Map(bucketStarts(from, to, period).map(start => [start, { totals: emptyTotals(), models: new Map<string, ModelUsage>() }]));
  const models = new Map<string, ModelUsage>();
  const totals = emptyTotals();
  const modelIn = (map: Map<string, ModelUsage>, call: UsageLedgerEvent) => {
    const key = `${call.provider}\u0000${call.model}`;
    let row = map.get(key);
    if (!row) map.set(key, row = { provider: call.provider, model: call.model, ...emptyTotals() });
    return row;
  };
  for (const ledger of ledgers) {
    for (const call of ledger) {
      const day = dayOf(call.ts);
      if (day < from || day > to) continue;
      const bucket = buckets.get(bucketStart(day, period));
      if (!bucket) continue;
      add(bucket.totals, call);
      add(modelIn(bucket.models, call), call);
      add(modelIn(models, call), call);
      add(totals, call);
    }
  }
  return {
    period, timeZone, from, to,
    buckets: [...buckets].map(([start, bucket]) => ({ start, totals: bucket.totals, models: [...bucket.models.values()].sort(byTokens) })),
    models: [...models.values()].sort(byTokens),
    totals, sessions: options.sessions, unreadSessions: options.unreadSessions,
  };
}

/** The default range ending today: 30 days, 12 weeks or 12 months. */
export function defaultUsageRange(period: UsagePeriod, today: string): { from: string; to: string } {
  if (period === "day") return { from: isoDay(dayNumber(today) - 29 * DAY_MS), to: today };
  if (period === "week") return { from: isoDay(dayNumber(bucketStart(today, "week")) - 11 * 7 * DAY_MS), to: today };
  const date = new Date(dayNumber(bucketStart(today, "month")));
  date.setUTCMonth(date.getUTCMonth() - 11);
  return { from: isoDay(date.getTime()), to: today };
}

/** The billed calls of a session file's text. Only lines that can hold usage or a model change are parsed; bad lines are skipped. */
export function usageLedgerFromJsonl(content: string): UsageLedgerEvent[] {
  const entries: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.includes("\"usage\"") && !line.includes("\"model_change\"")) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn or foreign line holds no usage we can trust */ }
  }
  return usageLedger(entries);
}

/** Ledgers by file, reused while the file's identity (inode, size, times) is unchanged. */
export class UsageLedgerCache {
  private readonly entries = new Map<string, { fingerprint: string; ledger: readonly UsageLedgerEvent[] }>();
  constructor(private readonly limit = 10_000) {}

  get(file: string, fingerprint: string): readonly UsageLedgerEvent[] | undefined {
    const cached = this.entries.get(file);
    return cached?.fingerprint === fingerprint ? cached.ledger : undefined;
  }

  set(file: string, fingerprint: string, ledger: readonly UsageLedgerEvent[]): void {
    this.entries.delete(file);
    if (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(file, { fingerprint, ledger });
  }
}
