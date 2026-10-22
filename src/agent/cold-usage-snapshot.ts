// Usage for a session that has no live runtime: the same session totals and context estimate a live
// AgentSession reports (getSessionStats / getContextUsage), computed from the persisted entries only.
// Pi does not export its context estimator, so this follows Pi 1.3's rules with its exported parts.

import { getCurrentSystemMessage, type Message } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens, getLatestCompactionEntry, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { nonnegative, type UsageSnapshot, type UsageTokens } from "../core/usage-snapshot.js";
import { subagentUsage } from "./subagent-transcript.js";

type StoredUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number; cost?: { total?: number } };
type AssistantLike = { role: "assistant"; stopReason?: string; usage?: StoredUsage };

/** A model the session would run on, and how its context window is looked up. */
export type ColdUsageOptions = {
  /** The model recorded for the session (database index, else the service default). The transcript's own model wins. */
  readonly fallbackModel?: { readonly provider: string; readonly modelId: string } | null;
  readonly contextWindow?: (provider: string, modelId: string) => number | null;
};

function usableUsage(message: unknown): StoredUsage | undefined {
  const m = message as AssistantLike | undefined;
  if (m?.role !== "assistant" || !m.usage || m.stopReason === "aborted" || m.stopReason === "error") return undefined;
  return calculateContextTokens(m.usage as Parameters<typeof calculateContextTokens>[0]) > 0 ? m.usage : undefined;
}

/**
 * Pi's `getSessionStats().tokens/cost` rule over the given entries: every entry of the file for the
 * session totals, the current branch (`getBranch()`) for the branch totals.
 */
export function entryUsageTotals<S extends "allEntries" | "branch">(entries: readonly SessionEntry[], scope: S): UsageTokens & { scope: S } {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  const add = (usage: StoredUsage | undefined) => {
    if (!usage) return;
    input += usage.input; output += usage.output; cacheRead += usage.cacheRead; cacheWrite += usage.cacheWrite;
    cost += usage.cost?.total ?? 0;
  };
  for (const entry of entries as Array<SessionEntry & { usage?: StoredUsage; message?: { role?: string; usage?: StoredUsage } }>) {
    if (entry.type === "usage") add(entry.usage);
    else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) add(entry.usage);
    else if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) add(entry.message.usage);
  }
  return { scope, input: nonnegative(input), output: nonnegative(output), cacheRead: nonnegative(cacheRead),
    cacheWrite: nonnegative(cacheWrite), totalTokens: nonnegative(input + output + cacheRead + cacheWrite), costUsdEstimate: nonnegative(cost) };
}

/** Pi's `getContextUsage().tokens`; null while a compaction has no later model response to measure it. */
function contextTokens(manager: SessionManager): number | null {
  const projection = manager.buildSessionProjection();
  const branch = manager.getBranch();
  const usedEntries = new Set(projection.entries.filter(entry => entry.messages.some(m => usableUsage(m))).map(entry => entry.sourceEntry.id));
  const compaction = getLatestCompactionEntry(branch);
  if (compaction) {
    const after = branch.slice(branch.findIndex(entry => entry.id === compaction.id) + 1);
    if (!after.some(entry => usedEntries.has(entry.id))) return null;
  }
  const messages = projection.messages as Message[];
  // The last measured response, plus an estimate of whatever followed it.
  let usageIndex = -1;
  for (let i = messages.length - 1; i >= 0 && usageIndex < 0; i--) if (usableUsage(messages[i])) usageIndex = i;
  if (usageIndex >= 0) {
    let start = 0;
    let usageEntryId: string | undefined;
    for (const entry of projection.entries) {
      if (usageIndex < start + entry.messages.length) { usageEntryId = entry.sourceEntry.id; break; }
      start += entry.messages.length;
    }
    const usageEntryIndex = usageEntryId ? branch.findIndex(entry => entry.id === usageEntryId) : -1;
    let invalidatedAt = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]!.type === "context_edit" || branch[i]!.type === "compaction") { invalidatedAt = i; break; }
    }
    if (usageEntryIndex > invalidatedAt) {
      let tokens = calculateContextTokens(usableUsage(messages[usageIndex])! as Parameters<typeof calculateContextTokens>[0]);
      for (let i = usageIndex + 1; i < messages.length; i++) tokens += estimateTokens(messages[i]! as Parameters<typeof estimateTokens>[0]);
      return tokens;
    }
  }
  // No trustworthy measurement: estimate the whole projected context.
  const system = getCurrentSystemMessage(messages);
  let tokens = system ? estimateTokens(system as Parameters<typeof estimateTokens>[0]) : 0;
  for (const message of messages) if (message.role !== "system") tokens += estimateTokens(message as Parameters<typeof estimateTokens>[0]);
  return tokens;
}

/** Session and branch totals, context and child-agent usage of a persisted session; each part is null when unknown. */
export function projectColdUsage(manager: SessionManager, options: ColdUsageOptions = {}): Pick<UsageSnapshot, "sessionTotals" | "branchTotals" | "context" | "subagentTotals" | "subagentAllTotals"> {
  let sessionTotals: UsageSnapshot["sessionTotals"] = null;
  let branchTotals: UsageSnapshot["branchTotals"] = null;
  let context: UsageSnapshot["context"] = null;
  let subagentTotals: UsageSnapshot["subagentTotals"] = null;
  let subagentAllTotals: UsageSnapshot["subagentAllTotals"] = null;
  try { sessionTotals = entryUsageTotals(manager.getEntries(), "allEntries"); } catch { /* unknown */ }
  try { branchTotals = entryUsageTotals(manager.getBranch(), "branch"); } catch { /* unknown */ }
  try {
    const model = (manager.buildSessionContext().model as { provider: string; modelId: string } | null | undefined) ?? options.fallbackModel ?? null;
    const window = model && options.contextWindow ? nonnegative(options.contextWindow(model.provider, model.modelId)) : null;
    if (window !== null && window > 0) {
      const tokens = nonnegative(contextTokens(manager));
      context = { tokens, window, percent: tokens === null ? null : nonnegative(tokens / window * 100), estimate: true };
    }
  } catch { /* unknown */ }
  try { subagentTotals = subagentUsage(manager.getBranch()); } catch { /* unknown */ }
  try { subagentAllTotals = subagentUsage(manager.getEntries()); } catch { /* unknown */ }
  return { sessionTotals, branchTotals, context, subagentTotals, subagentAllTotals };
}
