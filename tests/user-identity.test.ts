import { describe, it, expect } from "vitest";
import {
  resolveIdentity,
  identityKey,
  type IdentityContext,
} from "../src/core/user-identity.js";

describe("身份识别（needs.md §4.2 UserIdentity）", () => {
  describe("resolveIdentity", () => {
    it("内网请求按来源 IP 识别", () => {
      const ctx: IdentityContext = { sourceIp: "10.1.2.3", isIntranet: true };
      expect(resolveIdentity(ctx)).toEqual({ kind: "ip", ip: "10.1.2.3" });
    });

    it("内网请求忽略账号字段", () => {
      const ctx: IdentityContext = {
        sourceIp: "10.1.2.3",
        isIntranet: true,
        accountId: "acct-1",
      };
      expect(resolveIdentity(ctx)).toEqual({ kind: "ip", ip: "10.1.2.3" });
    });

    it("公网请求按签发账号识别", () => {
      const ctx: IdentityContext = {
        sourceIp: "203.0.113.5",
        isIntranet: false,
        accountId: "acct-42",
      };
      expect(resolveIdentity(ctx)).toEqual({ kind: "account", accountId: "acct-42" });
    });

    it("公网请求缺账号则报错", () => {
      const ctx: IdentityContext = { sourceIp: "203.0.113.5", isIntranet: false };
      expect(() => resolveIdentity(ctx)).toThrow();
    });
  });

  describe("identityKey", () => {
    it("IP 身份生成 ip: 前缀键", () => {
      expect(identityKey({ kind: "ip", ip: "10.1.2.3" })).toBe("ip:10.1.2.3");
    });

    it("账号身份生成 account: 前缀键", () => {
      expect(identityKey({ kind: "account", accountId: "acct-42" })).toBe("account:acct-42");
    });

    it("相同身份生成相同键", () => {
      const a = identityKey({ kind: "ip", ip: "10.0.0.1" });
      const b = identityKey({ kind: "ip", ip: "10.0.0.1" });
      expect(a).toBe(b);
    });

    it("IP 与账号即使取值相同也不冲突（类型前缀隔离）", () => {
      // 账号 "10.1.2.3" 与 IP "10.1.2.3" 必须不同键
      const ipKey = identityKey({ kind: "ip", ip: "10.1.2.3" });
      const acctKey = identityKey({ kind: "account", accountId: "10.1.2.3" });
      expect(ipKey).not.toBe(acctKey);
    });
  });
});
