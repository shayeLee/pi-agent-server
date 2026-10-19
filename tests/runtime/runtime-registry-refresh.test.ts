import { describe, expect, it } from "vitest";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentAdapter } from "../../src/agent/agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const turn: AgentSdkEvent[] = [
  { type: "agent_start" },
  { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
  { type: "agent_end", messages: [], willRetry: false },
];

/** 每次创建一个新 adapter；`outdated` 决定已有 adapter 是否过期，`fail` 让下一次创建失败。 */
function setup() {
  const state = { outdated: false, fail: false, created: [] as MockAgentAdapter[] };
  const createAdapter = async (): Promise<AgentAdapter> => {
    if (state.fail) throw new Error("cannot open");
    const adapter = Object.assign(new MockAgentAdapter([...turn]), { isOutdated: async () => state.outdated });
    state.created.push(adapter);
    return adapter;
  };
  const registry = new RuntimeRegistry({
    concurrency: new ConcurrencyController({ globalLimit: 2, perUserLimit: 2, perUserQueueLimit: 2, globalQueueLimit: 4, queueTimeoutMs: 5000 }),
    createAdapter, now: () => 0,
  });
  return { registry, state };
}

describe("RuntimeRegistry.refreshIfOutdated", () => {
  it("swaps in a new runtime on the same event bus once the session's MCP servers changed", async () => {
    const { registry, state } = setup();
    const first = await registry.getOrCreate("s1", "owner");
    await registry.refreshIfOutdated("s1", "owner");
    expect((await registry.getOrCreate("s1", "owner")).runtime).toBe(first.runtime);

    state.outdated = true;
    await registry.refreshIfOutdated("s1", "owner");
    const second = await registry.getOrCreate("s1", "owner");
    expect(second.runtime).not.toBe(first.runtime);
    expect(second.events).toBe(first.events);
    expect(state.created).toHaveLength(2);
    expect(state.created[0]!.calls.at(-1)).toEqual({ method: "dispose" });

    // 新 runtime 的事件进同一个总线，游标接着往下走。
    const seen: number[] = [];
    second.events.subscribe(item => seen.push(item.id), 0);
    state.outdated = false;
    expect(await second.runtime.submitMessage({ requestId: "r1", userId: "owner", prompt: "hi" })).toEqual({ kind: "run" });
    await flush();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("leaves a busy session alone", async () => {
    const { registry, state } = setup();
    const entry = await registry.getOrCreate("s1", "owner");
    state.created[0]!.prompt = () => new Promise<void>(() => {});
    await entry.runtime.submitMessage({ requestId: "r1", userId: "owner", prompt: "long" });
    state.outdated = true;
    await registry.refreshIfOutdated("s1", "owner");
    expect((await registry.getOrCreate("s1", "owner")).runtime).toBe(entry.runtime);
    expect(state.created).toHaveLength(1);
  });

  it("keeps the old runtime when the new one cannot be created", async () => {
    const { registry, state } = setup();
    const entry = await registry.getOrCreate("s1", "owner");
    state.outdated = true;
    state.fail = true;
    await registry.refreshIfOutdated("s1", "owner");
    expect((await registry.getOrCreate("s1", "owner")).runtime).toBe(entry.runtime);
    expect(state.created[0]!.calls.some(call => call.method === "dispose")).toBe(false);
  });

  it("does nothing for sessions without a runtime or deleted meanwhile", async () => {
    const { registry, state } = setup();
    state.outdated = true;
    await registry.refreshIfOutdated("absent", "owner");
    expect(registry.get("absent")).toBeUndefined();
    await registry.getOrCreate("s1", "owner");
    await registry.delete("s1");
    await registry.refreshIfOutdated("s1", "owner");
    expect(state.created).toHaveLength(1);
  });
});
