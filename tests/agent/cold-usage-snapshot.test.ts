import { describe, expect, it } from "vitest";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { projectColdUsage } from "../../src/agent/cold-usage-snapshot.js";

const usage = (input: number, output: number, cost = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const assistant = (text: string, used: ReturnType<typeof usage>, stopReason = "stop") => ({ role: "assistant" as const, content: [{ type: "text" as const, text }],
  api: "openai-responses", provider: "openai", model: "m", usage: used, stopReason, timestamp: 1 });
const windows = (sizes: Record<string, number>) => (provider: string, modelId: string) => sizes[`${provider}/${modelId}`] ?? null;

function conversation() {
  const manager = SessionManager.inMemory();
  manager.appendModelChange("openai", "m");
  manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  manager.appendMessage(assistant("one", usage(300, 50, 0.01)) as never);
  manager.appendMessage({ role: "user", content: "second question", timestamp: 2 });
  return manager;
}

describe("usage of a session without a live runtime", () => {
  it("measures the context from the last response plus what followed it", () => {
    const manager = conversation();
    const trailing = { role: "user" as const, content: "second question", timestamp: 2 };
    const { context } = projectColdUsage(manager, { contextWindow: windows({ "openai/m": 1000 }) });
    const tokens = 350 + estimateTokens(trailing as never);
    expect(context).toEqual({ tokens, window: 1000, percent: tokens / 1000 * 100, estimate: true });
  });

  it("ignores failed responses when choosing the measurement", () => {
    const manager = conversation();
    manager.appendMessage(assistant("", usage(900, 0), "error") as never);
    const { context } = projectColdUsage(manager, { contextWindow: windows({ "openai/m": 1000 }) });
    expect(context!.tokens).toBeGreaterThan(350);
    expect(context!.tokens).toBeLessThan(900);
  });

  it("reports unknown tokens after a compaction until a model responds again", () => {
    const manager = conversation();
    const kept = manager.getBranch().at(-1)!.id;
    manager.appendCompaction("summary", kept, 350);
    const { context } = projectColdUsage(manager, { contextWindow: windows({ "openai/m": 1000 }) });
    expect(context).toEqual({ tokens: null, window: 1000, percent: null, estimate: true });
    manager.appendMessage(assistant("two", usage(120, 10)) as never);
    expect(projectColdUsage(manager, { contextWindow: windows({ "openai/m": 1000 }) }).context?.tokens).toBe(130);
  });

  it("uses the transcript's model before the recorded one, and has no context without a window", () => {
    const manager = conversation();
    const options = { fallbackModel: { provider: "other", modelId: "x" }, contextWindow: windows({ "other/x": 5000, "openai/m": 2000 }) };
    expect(projectColdUsage(manager, options).context?.window).toBe(2000);
    const bare = SessionManager.inMemory();
    bare.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    expect(projectColdUsage(bare, options).context?.window).toBe(5000);
    expect(projectColdUsage(bare, { fallbackModel: options.fallbackModel }).context).toBeNull();
    expect(projectColdUsage(manager, { contextWindow: windows({}) }).context).toBeNull();
  });

  it("keeps whole-file and current-branch totals apart, for the session and its child agents", () => {
    const manager = conversation();
    const branchPoint = manager.getBranch().at(-2)!.id;
    const child = (id: string, seq: number, kind: string, payload: Record<string, unknown>) =>
      manager.appendCustomEntry("agent-team:transcript", { version: 1, id, seq, kind, timestamp: seq, payload });
    manager.appendMessage(assistant("two", usage(400, 20, 0.02)) as never);
    child("old", 1, "start", { runId: "1", agent: "worker", task: "t", startedAt: 1 });
    child("old", 2, "message", { key: "m", complete: true, message: { role: "assistant", usage: usage(1000, 100, 0.1) } });
    manager.branch(branchPoint);
    manager.appendMessage(assistant("alt", usage(10, 5, 0.001)) as never);
    const cold = projectColdUsage(manager);
    expect(cold.sessionTotals).toMatchObject({ scope: "allEntries", input: 710, output: 75, totalTokens: 785 });
    expect(cold.sessionTotals!.costUsdEstimate).toBeCloseTo(0.031);
    expect(cold.branchTotals).toMatchObject({ scope: "branch", input: 310, output: 55, totalTokens: 365 });
    expect(cold.branchTotals!.costUsdEstimate).toBeCloseTo(0.011);
    expect(cold.subagentTotals).toBeNull();
    expect(cold.subagentAllTotals).toMatchObject({ runs: 1, calls: 1, totalTokens: 1100 });
  });
});
