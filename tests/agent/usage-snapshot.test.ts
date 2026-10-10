import { describe, it, expect } from "vitest";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent, SseEvent } from "../../src/agent/events.js";
import { cacheHitPercent, responseSpeed } from "../../src/core/usage-snapshot.js";
import { applySseEvent, createChatState } from "../../src/client/chat-state.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";

const usage = { input: 120, output: 8, cacheRead: 20, cacheWrite: 12, totalTokens: 160,
  reasoning: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
function fixture() {
  const listeners = new Set<(e: AgentSdkEvent) => void>();
  let clock = 0;
  let context: ReturnType<NonNullable<AgentSessionLike["getContextUsage"]>> = { tokens: 160, contextWindow: 1000, percent: 16 };
  const session: AgentSessionLike = {
    messages: [], prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {},
    navigateTree: async () => {}, setModel: async () => {}, setThinkingLevel: () => {}, dispose: () => {},
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getContextUsage: () => context,
    getSessionStats: () => ({ tokens: { input: 1000, output: 100, cacheRead: 200, cacheWrite: 300, total: 1600 }, cost: 0.01 }),
  };
  const adapter = new PiAgentAdapter(session, () => ({}), undefined, () => clock);
  const emit = (e: AgentSdkEvent) => { for (const listener of listeners) listener(e); };
  const start = () => emit({ type: "message_start", message: { role: "assistant" } });
  const delta = (type: "text_delta" | "thinking_delta" | "toolcall_delta" = "text_delta", text = "x") => emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type, contentIndex: 0, delta: text } });
  const end = (u: unknown = usage) => emit({ type: "message_end", message: { role: "assistant", usage: u, stopReason: "error" } });
  return { session, adapter, emit, start, delta, end, at: (n: number) => { clock = n; }, context: (c: typeof context) => { context = c; } };
}

describe("authorized SDK usage snapshots", () => {
  it("uses SDK cache/cost/totals and final response timing, excluding tool waiting and other assistant responses", async () => {
    const f = fixture();
    await f.adapter.prompt("p");
    f.start(); f.at(100); f.delta("toolcall_delta"); f.at(200); f.end();
    f.at(10000); f.start(); f.delta("thinking_delta", ""); f.at(11000); f.delta("thinking_delta");
    f.at(11500); f.end();
    const snapshot = await f.adapter.getUsageSnapshot();
    expect(snapshot.lastResponse).toMatchObject({ input: 120, output: 8, totalTokens: 160, cacheRead: 20, cacheWrite: 12,
      costUsdEstimate: 0.003, ordinal: 2, cacheHitPercent: 20 / 152 * 100,
      speed: { outputTokens: 8, generationDurationMs: 500, tokensPerSecond: 16 } });
    expect(snapshot.sessionTotals).toEqual({ scope: "allEntries", input: 1000, output: 100, cacheRead: 200, cacheWrite: 300, totalTokens: 1600, costUsdEstimate: 0.01 });
    expect(snapshot.context).toEqual({ tokens: 160, window: 1000, percent: 16, estimate: true });
    expect(await f.adapter.getLastUsage()).toEqual({ promptTokens: 120, completionTokens: 8, totalTokens: 160 });
    expect((await f.adapter.exportSession() as { usageSnapshot: unknown }).usageSnapshot).toEqual(snapshot);
  });

  it("resets at prompt/assistant start; abort without usage is unknown, no previous response fallback", async () => {
    const f = fixture(); await f.adapter.prompt("p"); f.start(); f.delta(); f.at(100); f.end();
    f.start(); expect((await f.adapter.getUsageSnapshot()).lastResponse).toBeNull();
    f.end(undefined); // default supplies usage, then explicitly test missing
    f.start(); f.end(null); await f.adapter.abort();
    expect(await f.adapter.getLastUsage()).toBeNull();
    expect((await f.adapter.getUsageSnapshot()).lastResponse?.output).toBeNull();
    await f.adapter.prompt("next");
    expect((await f.adapter.getUsageSnapshot()).lastResponse).toBeNull();
  });

  it("accepts zero and isolates invalid fields without inventing costs or output estimates", async () => {
    const f = fixture(); await f.adapter.prompt("p"); f.start(); f.delta(); f.at(10);
    f.end({ ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } });
    expect((await f.adapter.getUsageSnapshot()).lastResponse).toMatchObject({ input: 0, output: 0, cacheHitPercent: null, costUsdEstimate: 0, speed: { tokensPerSecond: 0 } });
    f.start(); f.delta(); f.at(50); f.end({ ...usage, output: NaN, cacheRead: -1, cost: { total: Infinity } });
    expect((await f.adapter.getUsageSnapshot()).lastResponse).toMatchObject({ input: 120, output: null, cacheRead: null, costUsdEstimate: null, cacheHitPercent: null, speed: { tokensPerSecond: null } });
  });

  it("threshold is explicit, no 250ms floor or 1000tok/s cap; invalid clocks and divisors are unknown", () => {
    expect(responseSpeed(100, 9.999).tokensPerSecond).toBeNull();
    expect(responseSpeed(100, 10).tokensPerSecond).toBe(10000);
    expect(cacheHitPercent(0, 0, 0)).toBeNull();
    expect(cacheHitPercent(Number.MAX_VALUE, Number.MAX_VALUE, 0)).toBeNull();
  });

  it("context is reread across compaction, model changes, navigation; separate restored session has no historical speed", async () => {
    const f = fixture(); await f.adapter.prompt("p"); f.start(); f.at(100); f.delta(); f.at(50); f.end();
    expect((await f.adapter.getUsageSnapshot()).lastResponse?.speed.generationDurationMs).toBeNull();
    f.context({ tokens: null, contextWindow: 1000, percent: null }); f.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    expect((await f.adapter.getUsageSnapshot()).context?.tokens).toBeNull();
    f.context({ tokens: 20, contextWindow: 2000, percent: 1 }); await f.adapter.setModel("p", "m");
    expect((await f.adapter.getUsageSnapshot()).context?.window).toBe(2000);
    await f.adapter.navigateTree("id"); expect((await f.adapter.getUsageSnapshot()).lastResponse).toBeNull();
    const other = fixture(); other.session.messages.push({ role: "assistant", usage });
    expect((await other.adapter.getUsageSnapshot()).lastResponse).toBeNull();
    other.context(undefined); expect((await other.adapter.getUsageSnapshot()).context).toBeNull();
  });

  it("compacted prefix cannot resurrect old usage in eventless compatibility fallback", async () => {
    const f = fixture(); f.session.messages.push({ role: "assistant", usage });
    await f.adapter.prompt("p"); f.session.messages = [{ role: "assistant", usage }];
    expect(await f.adapter.getLastUsage()).toBeNull();
    expect((await f.adapter.getUsageSnapshot()).lastResponse).toBeNull();
  });

  it("runtime emits snapshots and requestId, shared reducer preserves them and accepts legacy events", async () => {
    const f = fixture(); f.session.prompt = async () => { f.emit({ type: "agent_start" }); f.start(); f.delta(); f.at(500); f.end(); };
    const events: SseEvent[] = [];
    const runtime = new SessionRuntime({ sessionId: "s", ownerKey: "o", adapter: f.adapter, now: () => 0,
      concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 1, perUserQueueLimit: 1, queueTimeoutMs: 1000 }),
      onEvent: e => { events.push(e); } });
    await runtime.submitMessage({ requestId: "r", userId: "o", prompt: "p" });
    await new Promise(resolve => setTimeout(resolve, 0));
    const event = events.find(e => e.type === "usage");
    expect(event).toMatchObject({ requestId: "r", lastResponse: { ordinal: 1 }, sessionTotals: { scope: "allEntries" }, context: { estimate: true } });
    let state = applySseEvent(createChatState(), event!);
    expect(state.stats?.lastResponse?.speed.tokensPerSecond).toBe(16);
    state = applySseEvent(state, { type: "status", phase: "agent_start" });
    expect(state.stats?.lastResponse).toBeNull(); expect(state.stats?.context).toBeNull();
    state = applySseEvent(state, { type: "usage", promptTokens: 1, completionTokens: 2, totalTokens: 3, durationMs: 4, ttftMs: 1 });
    expect(state.stats).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3, durationMs: 4, ttftMs: 1, execution: event?.type === "usage" ? event.execution : undefined });
    runtime.dispose();
  });
});
