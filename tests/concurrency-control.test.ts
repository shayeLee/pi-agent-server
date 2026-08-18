import { describe, it, expect } from "vitest";
import {
  ConcurrencyController,
  type ConcurrencyConfig,
} from "../src/core/concurrency-control.js";

const base: ConcurrencyConfig = {
  globalLimit: 2,
  perUserLimit: 2,
  perUserQueueLimit: 2,
  globalQueueLimit: 4,
  queueTimeoutMs: 5000,
};

describe("并发控制（needs.md §4.2）", () => {
  describe("直接运行", () => {
    it("未超限时直接运行", () => {
      const c = new ConcurrencyController(base);
      expect(c.submit("t1", "u1", 0)).toEqual({ kind: "run" });
      expect(c.activeCount()).toBe(1);
    });
  });

  describe("排队", () => {
    it("同一用户超出每用户上限排队", () => {
      const c = new ConcurrencyController(base);
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u1", 0); // run（perUserLimit=2）
      expect(c.submit("t3", "u1", 0)).toEqual({ kind: "queue", position: 1 });
    });

    it("全局超限时排队（不同用户）", () => {
      const c = new ConcurrencyController({ ...base, perUserLimit: 3 });
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u2", 0); // run（globalLimit=2）
      expect(c.submit("t3", "u3", 0)).toEqual({ kind: "queue", position: 1 });
    });
  });

  describe("拒绝", () => {
    it("每用户队列满返回 user-queue-full", () => {
      const c = new ConcurrencyController(base);
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u1", 0); // run
      c.submit("t3", "u1", 0); // queue
      c.submit("t4", "u1", 0); // queue（队列满，perUserQueueLimit=2）
      expect(c.submit("t5", "u1", 0)).toEqual({
        kind: "reject",
        reason: "user-queue-full",
      });
    });

    it("全局队列满返回 global-overload", () => {
      const c = new ConcurrencyController({
        ...base,
        globalLimit: 1,
        perUserLimit: 1,
        globalQueueLimit: 2,
      });
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u2", 0); // queue
      c.submit("t3", "u3", 0); // queue（全局队列满 2）
      expect(c.submit("t4", "u4", 0)).toEqual({
        kind: "reject",
        reason: "global-overload",
      });
    });
  });

  describe("释放与出队", () => {
    it("finish 释放后队列头部出队", () => {
      const c = new ConcurrencyController({ ...base, perUserLimit: 1 });
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u1", 0); // queue
      expect(c.finish("t1")).toEqual(["t2"]);
      expect(c.activeCount()).toBe(1);
      expect(c.queuedCount()).toBe(0);
    });

    it("finish 后跨用户出队受全局限制", () => {
      const c = new ConcurrencyController({ ...base, perUserLimit: 1, globalLimit: 1 });
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u2", 0); // queue
      c.submit("t3", "u3", 0); // queue
      // finish t1 释放 1 个全局槽位 → 只出队 t2
      expect(c.finish("t1")).toEqual(["t2"]);
      expect(c.queuedCount()).toBe(1);
    });

    it("排队任务出队后占满槽位，不再继续出队", () => {
      const c = new ConcurrencyController({ ...base, globalLimit: 1, perUserLimit: 1 });
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u2", 0); // queue
      c.submit("t3", "u3", 0); // queue
      expect(c.finish("t1")).toEqual(["t2"]); // t3 仍排队（全局满）
      expect(c.queuedCount()).toBe(1);
    });
  });

  describe("取消与超时", () => {
    it("cancelQueued 从队列移除", () => {
      const c = new ConcurrencyController({ ...base, perUserLimit: 1 });
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u1", 0); // queue
      expect(c.cancelQueued("t2")).toBe(true);
      expect(c.queuedCount()).toBe(0);
      expect(c.finish("t1")).toEqual([]);
    });

    it("cancelQueued 对不存在的任务返回 false", () => {
      const c = new ConcurrencyController(base);
      expect(c.cancelQueued("nope")).toBe(false);
    });

    it("expireQueued 移除超时任务", () => {
      const c = new ConcurrencyController({ ...base, perUserLimit: 1, queueTimeoutMs: 100 });
      c.submit("t1", "u1", 0); // run
      c.submit("t2", "u1", 0); // queue @ t=0
      expect(c.expireQueued(50)).toEqual([]); // 未超时
      expect(c.expireQueued(101)).toEqual(["t2"]); // 超时移除
      expect(c.queuedCount()).toBe(0);
    });
  });

  describe("计数", () => {
    it("activeCount 与 queuedCount 正确", () => {
      const c = new ConcurrencyController(base);
      c.submit("t1", "u1", 0);
      c.submit("t2", "u1", 0);
      c.submit("t3", "u1", 0); // queue
      expect(c.activeCount()).toBe(2);
      expect(c.queuedCount()).toBe(1);
    });
  });
});
