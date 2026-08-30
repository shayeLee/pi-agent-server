// PG int8（BIGINT）→ 安全 JS number 的读回边界单测（工作包 C，无需真实 PG）：
// - parsePgInt8：安全整数内转 number；超出 Number.MAX_SAFE_INTEGER 显式抛错（不静默丢精度）；
// - createPgInt8SafeTypes：per-pool CustomTypes 只覆盖 OID 20（int8），其余类型沿用 pg 默认解析。

import { describe, it, expect } from "vitest";
import { createPgInt8SafeTypes, parsePgInt8 } from "../../src/storage/pg-int8.js";

describe("parsePgInt8（int8 文本 → 安全 JS number）", () => {
  it("安全整数范围内转为 number", () => {
    expect(parsePgInt8("0")).toBe(0);
    expect(parsePgInt8("123")).toBe(123);
    expect(parsePgInt8("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsePgInt8("-9007199254740991")).toBe(-Number.MAX_SAFE_INTEGER);
    expect(parsePgInt8("1718000000000")).toBe(1718000000000); // 典型毫秒时间戳
  });

  it("超出 Number.MAX_SAFE_INTEGER 的值显式抛错（拒绝静默丢精度）", () => {
    expect(() => parsePgInt8("9007199254740992")).toThrow(/超出 JS 安全整数范围/);
    expect(() => parsePgInt8("-9007199254740992")).toThrow(/超出 JS 安全整数范围/);
    expect(() => parsePgInt8("9223372036854775807")).toThrow(/超出 JS 安全整数范围/); // int8 最大值
  });

  it("非整数（如 1.5）同样拒绝（不是安全整数）", () => {
    expect(() => parsePgInt8("1.5")).toThrow(/超出 JS 安全整数范围/);
  });
});

describe("createPgInt8SafeTypes（per-pool CustomTypes）", () => {
  const types = createPgInt8SafeTypes();

  it("OID 20（int8）解析为 parsePgInt8 语义", () => {
    const parser = types.getTypeParser(20) as (value: string) => unknown;
    expect(parser("1718000000000")).toBe(1718000000000);
    expect(() => parser("9223372036854775807")).toThrow(/超出 JS 安全整数范围/);
  });

  it("非 int8 OID（如 23 int4）沿用 pg 默认解析（仍是数字）", () => {
    const parser = types.getTypeParser(23) as (value: string) => unknown;
    expect(parser("42")).toBe(42);
  });

  it("binary 格式的 int8 解析保持可用（不抛错）", () => {
    expect(() => types.getTypeParser(20, "binary")).not.toThrow();
  });
});