import { describe, it, expect } from "vitest";
import { identityKey, type UserIdentity } from "../src/core/user-identity.js";

describe("身份（WP5D-2：identity = canonical 来源 IP，一个 IP = 一个用户）", () => {
  describe("identityKey", () => {
    it("IP 身份生成 ip: 前缀键（owner 隔离唯一键）", () => {
      expect(identityKey({ kind: "ip", ip: "10.1.2.3" })).toBe("ip:10.1.2.3");
    });

    it("相同身份生成相同键", () => {
      const a = identityKey({ kind: "ip", ip: "10.0.0.1" });
      const b = identityKey({ kind: "ip", ip: "10.0.0.1" });
      expect(a).toBe(b);
    });

    it("不同 IP 生成不同键", () => {
      const a = identityKey({ kind: "ip", ip: "10.0.0.1" });
      const b = identityKey({ kind: "ip", ip: "10.0.0.2" });
      expect(a).not.toBe(b);
    });
  });

  it("UserIdentity 形状：kind=ip + canonical ip 文本", () => {
    const identity: UserIdentity = { kind: "ip", ip: "127.0.0.1" };
    expect(identity).toEqual({ kind: "ip", ip: "127.0.0.1" });
  });
});