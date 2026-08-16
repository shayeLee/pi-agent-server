import { describe, it, expect } from "vitest";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import {
  ConcurrencyController,
  type ConcurrencyConfig,
} from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentAdapter } from "../../src/agent/agent-adapter.js";
import type { SseEvent } from "../../src/agent/events.js";

const baseConfig: ConcurrencyConfig = {
  globalLimit: 2,
  perUserLimit: 2,
  perUserQueueLimit: 2,
  globalQueueLimit: 4,
  queueTimeoutMs: 5000,
};

/** 等待后台流式任务完成（submitMessage 立即返回决策后，流式在微任务中继续）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeRegistry(opts: { adapters?: Map<string, MockAgentAdapter> } = {}) {
  const adapters = opts.adapters ?? new Map<string, MockAgentAdapter>();
  const createAdapter = async (sessionId: string): Promise<AgentAdapter> => {
    let adapter = adapters.get(sessionId);
    if (!adapter) {
      adapter = new MockAgentAdapter();
      adapters.set(sessionId, adapter);
    }
    return adapter;
  };
  const concurrency = new ConcurrencyController(baseConfig);
  const registry = new RuntimeRegistry({
    concurrency,
    createAdapter,
    now: () => 0,
  });
  return { registry, concurrency, adapters };
}

describe("RuntimeRegistry（会话 ↔ runtime/事件总线绑定管理）", () => {
  describe("getOrCreate：创建与复用", () => {
    it("同 sessionId 复用同一个 runtime 与 events", async () => {
      const { registry } = makeRegistry();
      const a = await registry.getOrCreate("s1", "owner-1");
      const b = await registry.getOrCreate("s1", "owner-1");

      expect(b.runtime).toBe(a.runtime);
      expect(b.events).toBe(a.events);
    });

    it("不同 sessionId 各自独立（runtime/events 互不相同）", async () => {
      const { registry } = makeRegistry();
      const a = await registry.getOrCreate("s1", "owner-1");
      const b = await registry.getOrCreate("s2", "owner-1");

      expect(a.runtime).not.toBe(b.runtime);
      expect(a.events).not.toBe(b.events);
    });

    it("createAdapter 工厂按 sessionId 只创建一次", async () => {
      const created: string[] = [];
      const concurrency = new ConcurrencyController(baseConfig);
      const registry = new RuntimeRegistry({
        concurrency,
        createAdapter: async (sessionId) => {
          created.push(sessionId);
          return new MockAgentAdapter();
        },
        now: () => 0,
      });

      await registry.getOrCreate("s1", "owner-1");
      await registry.getOrCreate("s1", "owner-1");
      expect(created).toEqual(["s1"]);
    });
  });

  describe("事件写入对应会话的 events", () => {
    it("MockAgentAdapter 触发一次流式，onEvent 写入该会话事件总线的缓冲", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const { registry } = makeRegistry({ adapters: new Map([["s1", adapter]]) });
      const { runtime, events } = await registry.getOrCreate("s1", "owner-1");

      // 直接订阅会话事件总线，验证断线重连视角（含 id）与实时视角一致
      const replayed: Array<{ id: number; event: SseEvent }> = [];
      events.subscribe((item) => replayed.push(item), 0);

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "你好",
      });
      await flush();

      expect(d).toEqual({ kind: "run" });
      expect(replayed.map((s) => s.id)).toEqual([1, 2, 3]);
      expect(replayed.map((s) => s.event)).toEqual([
        { type: "status", phase: "agent_start", requestId: "r1" },
        { type: "text_delta", text: "hi" },
        { type: "completed" },
      ]);
    });

    it("不同会话的事件互不串扰：流式事件只进本会话的 events", async () => {
      const adapterA = new MockAgentAdapter([
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A" },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const { registry } = makeRegistry({
        adapters: new Map([["sA", adapterA], ["sB", new MockAgentAdapter()]]),
      });
      const { runtime: runtimeA, events: eventsA } = await registry.getOrCreate("sA", "owner-1");
      const { events: eventsB } = await registry.getOrCreate("sB", "owner-1");

      const seenA: Array<{ id: number; event: SseEvent }> = [];
      const seenB: Array<{ id: number; event: SseEvent }> = [];
      eventsA.subscribe((item) => seenA.push(item), 0);
      eventsB.subscribe((item) => seenB.push(item), 0);

      await runtimeA.submitMessage({ requestId: "r1", userId: "user-1", prompt: "qA" });
      await flush();

      expect(seenA).toHaveLength(3);
      expect(seenB).toEqual([]); // sB 的事件总线未收到任何事件
    });
  });

  describe("delete：会话清理", () => {
    it("delete 后 getOrCreate 抛 SessionDeletedError（墓碑拒绝重建）", async () => {
      const { registry } = makeRegistry();
      await registry.getOrCreate("s1", "owner-1");
      await registry.delete("s1");
      await expect(registry.getOrCreate("s1", "owner-1")).rejects.toThrow(/已删除/);
    });

    it("delete 只影响被删会话，其他会话不受影响", async () => {
      const { registry } = makeRegistry();
      await registry.getOrCreate("s1", "owner-1");
      const b = await registry.getOrCreate("s2", "owner-1");

      await registry.delete("s1");

      // s1 墓碑：拒绝重建
      await expect(registry.getOrCreate("s1", "owner-1")).rejects.toThrow(/已删除/);

      // s2 不受影响：复用原实例
      const b2 = await registry.getOrCreate("s2", "owner-1");
      expect(b2.runtime).toBe(b.runtime);
      expect(b2.events).toBe(b.events);
    });

    it("delete 后不再调用 createAdapter（墓碑直接拒绝）", async () => {
      const created: string[] = [];
      const concurrency = new ConcurrencyController(baseConfig);
      const registry = new RuntimeRegistry({
        concurrency,
        createAdapter: async (sessionId) => {
          created.push(sessionId);
          return new MockAgentAdapter();
        },
        now: () => 0,
      });

      await registry.getOrCreate("s1", "owner-1");
      await registry.delete("s1");
      await expect(registry.getOrCreate("s1", "owner-1")).rejects.toThrow(/已删除/);
      expect(created).toEqual(["s1"]); // 只创建一次
    });

    it("delete 与并发 pending 创建：旧 entry 不写回，之后 getOrCreate 抛已删除", async () => {
      let resolveAdapter!: (a: AgentAdapter) => void;
      const adapterPromise = new Promise<AgentAdapter>((resolve) => {
        resolveAdapter = resolve;
      });
      const concurrency = new ConcurrencyController(baseConfig);
      const registry = new RuntimeRegistry({
        concurrency,
        createAdapter: () => adapterPromise, // 挂起，模拟慢创建
        now: () => 0,
      });

      // 并发：getOrCreate（pending 在途）与 delete
      const pendingGet = registry.getOrCreate("s1", "owner-1");
      const pendingDelete = registry.delete("s1");
      resolveAdapter(new MockAgentAdapter());
      await expect(pendingGet).rejects.toThrow(/已删除/); // pending 完成时检测到墓碑
      await pendingDelete;

      // 墓碑永久：之后 getOrCreate 仍拒绝
      await expect(registry.getOrCreate("s1", "owner-1")).rejects.toThrow(/已删除/);
    });
  });
});