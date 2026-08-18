import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { authenticate, type Authenticate } from "../../src/server/auth.js";

// 鉴权接口（needs.md §4.2 / docs/architecture.md ①②）
// 本步只固定接口签名与依赖注入边界；真实 Token 校验与内网/公网判定后续步骤接入。
describe("鉴权接口 authenticate", () => {
  it("接口签名：authenticate(request) → Promise<UserIdentity>，假鉴权可替换", async () => {
    // 编译期契约：测试注入的假鉴权可以直接替换真实实现，路由侧无感知
    const fake: Authenticate = async () => ({ kind: "ip", ip: "10.0.0.1" });
    expect(await fake({} as FastifyRequest)).toEqual({ kind: "ip", ip: "10.0.0.1" });
  });

  it("真实实现未接入：调用占位 authenticate 抛错（后续步骤替换）", async () => {
    await expect(authenticate({} as FastifyRequest)).rejects.toThrow();
  });
});