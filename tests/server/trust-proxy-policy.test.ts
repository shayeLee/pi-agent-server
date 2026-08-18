import { describe, expect, it } from "vitest";
import { validateTrustProxyConfig } from "../../src/server/trust-proxy-policy.js";

describe("validateTrustProxyConfig（内网免 token 安全校验）", () => {
  it("trustProxy=true 且配置内网网段时抛错", () => {
    expect(() => validateTrustProxyConfig(true, ["10.0.0.0/8"])).toThrow(/全信任/);
  });

  it("全信任 CIDR（0.0.0.0/0、::/0）且配置内网网段时抛错", () => {
    expect(() => validateTrustProxyConfig("0.0.0.0/0", ["10.0.0.0/8"])).toThrow(/CIDR/);
    expect(() => validateTrustProxyConfig("::/0", ["10.0.0.0/8"])).toThrow(/CIDR/);
    expect(() => validateTrustProxyConfig(["0.0.0.0/0", "::/0"], ["10.0.0.0/8"])).toThrow(/CIDR/);
  });

  it("组合 CIDR 覆盖全地址（0.0.0.0/1+128.0.0.0/1、::/1+8000::/1）且配置内网网段时抛错", () => {
    expect(() => validateTrustProxyConfig(["0.0.0.0/1", "128.0.0.0/1"], ["10.0.0.0/8"])).toThrow(/CIDR/);
    expect(() => validateTrustProxyConfig(["::/1", "8000::/1"], ["10.0.0.0/8"])).toThrow(/CIDR/);
  });

  it("逗号分隔字符串含 CIDR 且配置内网网段时抛错（Fastify 会按逗号拆分）", () => {
    expect(() => validateTrustProxyConfig("0.0.0.0/1,128.0.0.0/1", ["10.0.0.0/8"])).toThrow(/CIDR/);
  });

  it("数字跳数、函数、网段别名与非 IP 值且配置内网网段时抛错", () => {
    expect(() => validateTrustProxyConfig(1, ["10.0.0.0/8"])).toThrow(/数字跳数/);
    expect(() => validateTrustProxyConfig(() => true, ["10.0.0.0/8"])).toThrow(/白名单/);
    expect(() => validateTrustProxyConfig("loopback", ["10.0.0.0/8"])).toThrow(/具体/);
    expect(() => validateTrustProxyConfig("not-an-ip", ["10.0.0.0/8"])).toThrow(/具体/);
  });

  it("trustProxy=false / 具体 IP 白名单（含 IPv6）/ undefined 时不抛错", () => {
    expect(() => validateTrustProxyConfig(false, ["10.0.0.0/8"])).not.toThrow();
    expect(() => validateTrustProxyConfig("127.0.0.1", ["10.0.0.0/8"])).not.toThrow();
    expect(() => validateTrustProxyConfig("::1", ["10.0.0.0/8"])).not.toThrow();
    expect(() => validateTrustProxyConfig("127.0.0.1,10.0.0.2", ["10.0.0.0/8"])).not.toThrow();
    expect(() => validateTrustProxyConfig(["127.0.0.1", "10.0.0.2"], ["10.0.0.0/8"])).not.toThrow();
    expect(() => validateTrustProxyConfig(undefined, ["10.0.0.0/8"])).not.toThrow();
  });

  it("无内网网段时不抛错（无内网免 token 风险）", () => {
    expect(() => validateTrustProxyConfig(true, [])).not.toThrow();
    expect(() => validateTrustProxyConfig("0.0.0.0/0", [])).not.toThrow();
  });
});
