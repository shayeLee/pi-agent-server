import { expect, it, vi } from "vitest";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";
import type { ModelOutputProgress } from "../../src/agent/model-output-sampler.js";
it("1000 existing deltas merge into ≤5 progress publications per second, one timer, no SDK/HTTP reads", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const getSessionStats = vi.fn(); const getContextUsage = vi.fn();
  const listeners = new Set<(event: AgentSdkEvent) => void>();
  const emit = (event: AgentSdkEvent) => { for (const listener of listeners) listener(event); };
  let finish = () => {};
  const session: AgentSessionLike = { messages: [], prompt: () => new Promise<void>(resolve => { finish = resolve; }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getSessionStats, getContextUsage,
    abort: async () => { finish(); }, steer: async () => {}, followUp: async () => {}, navigateTree: async () => {}, setModel: async () => {}, setThinkingLevel: () => {}, dispose: () => {} };
  const adapter = new PiAgentAdapter(session, undefined, undefined, () => Date.now());
  const publications: ModelOutputProgress[] = [];
  adapter.subscribeModelOutputProgress(progress => publications.push(progress));
  try {
    const prompt = adapter.prompt("p");
    emit({ type: "message_start", message: { role: "assistant" } });
    for (let i = 0; i < 1000; i++) {
      vi.advanceTimersByTime(1);
      emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "中😀" } });
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    }
    vi.advanceTimersByTime(1);
    expect(publications.filter(p => p.phase === "delta").length).toBeLessThanOrEqual(5);
    emit({ type: "message_end", message: { role: "assistant" } });
    expect(publications.at(-1)?.phase).toBe("end");
    expect(vi.getTimerCount()).toBe(0);
    expect(getSessionStats).not.toHaveBeenCalled(); expect(getContextUsage).not.toHaveBeenCalled(); expect(fetchSpy).not.toHaveBeenCalled();
    // Abort cancels the sole dirty timer before SDK abort completion; no late activity.
    emit({ type: "message_start", message: { role: "assistant" } });
    const delta: AgentSdkEvent = { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } };
    emit(delta); emit(delta); expect(vi.getTimerCount()).toBe(1);
    await adapter.abort(); expect(vi.getTimerCount()).toBe(0);
    const count = publications.length; vi.advanceTimersByTime(5000); expect(publications.length).toBe(count);
    await prompt;
  } finally { finish(); adapter.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); }
});
