import { describe, it, expect } from "vitest";
import { IdempotencyStore } from "../src/core/idempotency.js";
import { payloadFingerprint } from "../src/core/payload-fingerprint.js";

describe("幂等去重（needs.md §4.2 requestId）", () => {
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

describe("幂等载荷指纹（同 requestId 不同 payload 冲突）", () => {
  it("指纹对 prompt/parentId/images 敏感，对无关顺序不敏感", () => {
    const base = payloadFingerprint({ prompt: "p" });
    expect(payloadFingerprint({ prompt: "p" })).toBe(base);
    expect(payloadFingerprint({ prompt: "q" })).not.toBe(base);
    expect(payloadFingerprint({ prompt: "p", parentId: "n1" })).not.toBe(base);
    expect(payloadFingerprint({ prompt: "p", images: [{ mediaType: "image/png", base64: "YQ==" }] })).not.toBe(base);
    expect(payloadFingerprint({ prompt: "p", images: [] })).toBe(base);
  });

  it("字段边界不歧义（长度前缀）", () => {
    expect(payloadFingerprint({ prompt: "a", parentId: "bc" })).not.toBe(
      payloadFingerprint({ prompt: "ab", parentId: "c" }),
    );
  });

  it("check 带指纹：同载荷返回 done/in-flight，不同载荷返回 payload-conflict", () => {
    const s = new IdempotencyStore();
    const a = payloadFingerprint({ prompt: "A" });
    expect(s.check("r", a)).toEqual({ status: "new" });
    // 完成前：同载荷 processing，不同载荷冲突
    expect(s.check("r", a)).toEqual({ status: "processing" });
    expect(s.check("r", payloadFingerprint({ prompt: "B" }))).toEqual({ status: "payload-conflict" });
    s.complete("r", { status: "completed" }, a);
    // 完成后：同载荷 done，不同载荷冲突（不返回旧结果）
    expect(s.check("r", a)).toEqual({ status: "done", result: { status: "completed" } });
    expect(s.check("r", payloadFingerprint({ prompt: "B" }))).toEqual({ status: "payload-conflict" });
  });

  it("check 不提供指纹时保持既有向后兼容语义", () => {
    const s = new IdempotencyStore();
    expect(s.check("r")).toEqual({ status: "new" });
    s.complete("r", { ok: true });
    expect(s.check("r")).toEqual({ status: "done", result: { ok: true } });
  });
});
