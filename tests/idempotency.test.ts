import { describe, it, expect } from "vitest";
import { IdempotencyStore } from "../src/core/idempotency.js";

describe("幂等去重（README §4.2 requestId）", () => {
  it("首次 check 返回 new", () => {
    const s = new IdempotencyStore();
    expect(s.check("req-1")).toEqual({ status: "new" });
  });

  it("处理中的重复 check 返回 processing", () => {
    const s = new IdempotencyStore();
    s.check("req-1"); // new（占位）
    expect(s.check("req-1")).toEqual({ status: "processing" });
  });

  it("complete 后返回 done 与原结果，不再重复执行", () => {
    const s = new IdempotencyStore();
    s.check("req-1");
    s.complete("req-1", { id: "msg-1" });
    expect(s.check("req-1")).toEqual({ status: "done", result: { id: "msg-1" } });
  });

  it("fail 释放占位后可重试", () => {
    const s = new IdempotencyStore();
    s.check("req-1");
    s.fail("req-1");
    expect(s.check("req-1")).toEqual({ status: "new" });
  });

  it("不同 key 互不影响", () => {
    const s = new IdempotencyStore();
    expect(s.check("req-1")).toEqual({ status: "new" });
    expect(s.check("req-2")).toEqual({ status: "new" });
  });

  it("重复提交返回同一结果（不重复执行）", () => {
    const s = new IdempotencyStore();
    // 第一次执行
    const first = s.check("req-1");
    expect(first.status).toBe("new");
    s.complete("req-1", { answer: "A" });
    // 第二次重复提交 → 命中 done，不执行
    const second = s.check("req-1");
    expect(second).toEqual({ status: "done", result: { answer: "A" } });
  });
});
