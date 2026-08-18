import { describe, it, expect } from "vitest";
import { SessionEventBus } from "../../src/runtime/session-event-bus.js";
import type { SseEvent } from "../../src/agent/events.js";

const text = (text: string): SseEvent => ({ type: "text_delta", text });

describe("SessionEventBus（needs.md §4.2 事件缓冲与 Last-Event-ID 补发）", () => {
  describe("push：递增 id 与有界缓冲", () => {
    it("push 分配从 1 开始的递增 id", () => {
      const bus = new SessionEventBus();
      expect(bus.push({ type: "text_delta", text: "a" })).toBe(1);
      expect(
        bus.push({ type: "tool_start", toolCallId: "c1", toolName: "read", args: {} }),
      ).toBe(2);
      expect(bus.push({ type: "completed" })).toBe(3);
    });

    it("有界缓冲淘汰最旧：maxEvents=3 时缓冲仅保留最近 3 条", () => {
      const bus = new SessionEventBus({ maxEvents: 3 });
      for (let i = 1; i <= 5; i++) bus.push(text(`t${i}`));

      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item), 0);
      expect(seen.map((s) => s.id)).toEqual([3, 4, 5]);
      expect(seen.map((s) => s.event)).toEqual([text("t3"), text("t4"), text("t5")]);
    });

    it("默认 maxEvents=1000：未超限前全部保留", () => {
      const bus = new SessionEventBus();
      for (let i = 1; i <= 1000; i++) bus.push(text(`t${i}`));

      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item), 0);
      expect(seen).toHaveLength(1000);
      expect(seen[0]?.id).toBe(1);
      expect(seen[999]?.id).toBe(1000);
    });
  });

  describe("实时订阅", () => {
    it("订阅者实时收到事件（含 id）", () => {
      const bus = new SessionEventBus();
      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item));

      bus.push(text("a"));
      bus.push({ type: "completed" });

      expect(seen).toEqual([
        { id: 1, event: text("a") },
        { id: 2, event: { type: "completed" } },
      ]);
    });

    it("多订阅者都收到同一事件流", () => {
      const bus = new SessionEventBus();
      const a: Array<{ id: number; event: SseEvent }> = [];
      const b: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => a.push(item));
      bus.subscribe((item) => b.push(item));

      bus.push(text("hi"));

      expect(a).toEqual([{ id: 1, event: text("hi") }]);
      expect(b).toEqual([{ id: 1, event: text("hi") }]);
    });

    it("退订后不再收到事件", () => {
      const bus = new SessionEventBus();
      const seen: Array<{ id: number; event: SseEvent }> = [];
      const unsub = bus.subscribe((item) => seen.push(item));

      bus.push(text("a"));
      expect(seen).toHaveLength(1);

      unsub();
      bus.push({ type: "completed" });
      bus.push({ type: "completed" });
      expect(seen).toHaveLength(1); // 退订后无新增
    });

    it("不带 lastEventId 订阅：不补发既有缓冲，仅接收之后的新事件", () => {
      const bus = new SessionEventBus();
      bus.push(text("a"));

      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item));
      expect(seen).toEqual([]);

      bus.push({ type: "completed" });
      expect(seen).toEqual([{ id: 2, event: { type: "completed" } }]);
    });
  });

  describe("Last-Event-ID 断线续传", () => {
    it("按序补发缓冲中 id > lastEventId 的事件，之后继续实时接收", () => {
      const bus = new SessionEventBus();
      bus.push(text("a"));
      bus.push(text("b"));
      bus.push({ type: "completed" });

      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item), 2);

      expect(seen).toEqual([{ id: 3, event: { type: "completed" } }]);

      bus.push(text("c"));
      expect(seen).toEqual([
        { id: 3, event: { type: "completed" } },
        { id: 4, event: text("c") },
      ]);
    });

    it("lastEventId 为 0 时按序补发缓冲内全部事件", () => {
      const bus = new SessionEventBus();
      bus.push(text("a"));
      bus.push(text("b"));
      bus.push(text("c"));

      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item), 0);

      expect(seen.map((s) => s.id)).toEqual([1, 2, 3]);
    });

    it("lastEventId 已是最新：补发为空集", () => {
      const bus = new SessionEventBus();
      bus.push({ type: "completed" });

      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item), 1);

      expect(seen).toEqual([]);
    });

    it("lastEventId 已被淘汰（小于缓冲最早 id）：只补发仍保留的事件", () => {
      const bus = new SessionEventBus({ maxEvents: 3 });
      for (let i = 1; i <= 5; i++) bus.push(text(`t${i}`));

      const seen: Array<{ id: number; event: SseEvent }> = [];
      bus.subscribe((item) => seen.push(item), 1); // id 1、2 的缓冲已被淘汰

      expect(seen.map((s) => s.id)).toEqual([3, 4, 5]);
      expect(seen.map((s) => s.event)).toEqual([text("t3"), text("t4"), text("t5")]);
    });
  });
});