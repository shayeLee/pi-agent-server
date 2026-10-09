import { expect, it } from "vitest";
import { ModelOutputSampler } from "../../src/agent/model-output-sampler.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";
import { applySseEvent, createChatState } from "../../src/client/chat-state.js";
import { SessionEventBus } from "../../src/runtime/session-event-bus.js";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
const start: AgentSdkEvent = { type: "message_start", message: { role: "assistant" } };
const end: AgentSdkEvent = { type: "message_end", message: { role: "assistant" } };
const delta = (text: string, type: "text_delta" | "thinking_delta" | "toolcall_delta" = "text_delta"): AgentSdkEvent => ({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type, contentIndex: 0, delta: text } });
it("samples real UTF-16 batch deltas, throttles, excludes tools, resets assistants and never clamps speed", () => {
  let clock = 0; const sampler = new ModelOutputSampler(() => clock);
  expect(sampler.sample(delta("stray"))).toBeNull();
  expect(sampler.sample(end)).toBeNull();
  expect(sampler.sample(start)).toMatchObject({ ordinal: 1, phase: "start" });
  expect(sampler.sample(delta(""))).toBeNull();
  expect(sampler.sample(delta("中文😀", "thinking_delta"))).toMatchObject({ tokensPerSecondEstimate: null, includesThinking: true });
  clock = 100; expect(sampler.sample(delta("abcd", "toolcall_delta"))).toBeNull();
  clock = 250; expect(sampler.sample(delta("abcd"))).toMatchObject({ tokensPerSecondEstimate: 12, includesThinking: true });
  expect(sampler.sample({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", args: {}, partialResult: "x".repeat(10000) })).toBeNull();
  expect(sampler.sample(end)).toMatchObject({ phase: "end" });
  clock = 100000; sampler.sample(start); sampler.sample(delta("x".repeat(2000)));
  clock += 250;
  expect(sampler.sample(delta("x".repeat(2000)))).toMatchObject({ ordinal: 2, tokensPerSecondEstimate: 4000, includesThinking: false });
  sampler.reset(); expect(sampler.sample(start)?.ordinal).toBe(1);
});
it("client activity is receipt-local, boundaries/terminal events clear it; replay cannot renew it", () => {
  const event = { type: "model_output_progress" as const, ordinal: 1, phase: "delta" as const, tokensPerSecondEstimate: 100, includesThinking: true };
  const state = applySseEvent(createChatState(), event, () => 42);
  expect(state.modelOutput?.receivedAt).toBe(42);
  const bus = new SessionEventBus(); bus.push(event);
  bus.subscribe(item => expect(applySseEvent(state, item.event, () => 1000).modelOutput).toBeNull(), 0);
  for (const terminal of [{ ...event, phase: "start" as const }, { ...event, phase: "end" as const }, { type: "completed" as const }, { type: "aborted" as const }, { type: "error" as const, message: "oops" }]) {
    expect(applySseEvent(state, terminal).modelOutput).toBeNull();
  }
});
it("does not infer active tools from old cards or orphan tool_update, and clears genuine lifecycle on terminal", () => {
  let state = applySseEvent(createChatState(), { type: "tool_start", toolCallId: "t", toolName: "bash", args: {} });
  expect(state.activeToolCallIds).toEqual(["t"]);
  state = applySseEvent(state, { type: "aborted" });
  expect(state.activeToolCallIds).toEqual([]);
  state = applySseEvent(state, { type: "status", phase: "agent_start" });
  expect(state.activeToolCallIds).toEqual([]);
  state = applySseEvent(state, { type: "tool_update", toolCallId: "orphan", toolName: "bash", partialResult: "x" });
  expect(state.activeToolCallIds).toEqual([]);
});
it("production adapter → runtime progress has requestId and leaves actual usage untouched", async () => {
  let clock = 0;
  const listeners = new Set<(event: AgentSdkEvent) => void>();
  const emit = (event: AgentSdkEvent) => { for (const listener of listeners) listener(event); };
  const usage = { input: 10, output: 99, cacheRead: 0, cacheWrite: 0, totalTokens: 109, cost: { total: 0 } };
  const session: AgentSessionLike = { messages: [], prompt: async () => {
    emit({ type: "agent_start" }); emit(start); emit(delta("abcd", "toolcall_delta")); clock = 500; emit(delta("abcd", "thinking_delta"));
    emit({ type: "message_end", message: { role: "assistant", usage } });
  }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    steer: async () => {}, followUp: async () => {}, abort: async () => {}, navigateTree: async () => {}, setModel: async () => {}, setThinkingLevel: () => {}, dispose: () => {} };
  const adapter = new PiAgentAdapter(session, undefined, undefined, () => clock);
  const events: import("../../src/agent/events.js").SseEvent[] = [];
  const runtime = new SessionRuntime({ sessionId: "s", ownerKey: "o", adapter, now: () => clock,
    concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 1, perUserQueueLimit: 1, queueTimeoutMs: 1000 }),
    onEvent: event => { events.push(event); } });
  await runtime.submitMessage({ requestId: "r", userId: "o", prompt: "p" });
  await new Promise(resolve => setTimeout(resolve, 20));
  const progress = events.filter(e => e.type === "model_output_progress");
  expect(progress.map(e => e.requestId)).toEqual(["r", "r", "r", "r"]);
  expect(events.find(e => e.type === "usage")).toMatchObject({ completionTokens: 99, lastResponse: { speed: { tokensPerSecond: 198 } } });
  await runtime.dispose();
});
