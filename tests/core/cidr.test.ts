import { describe, it, expect } from "vitest";
import { isInCidr, isInAnyCidr } from "../../src/core/cidr.js";

// IPv4 CIDR 匹配（needs.md §4.2 内网判定）
describe("isInCidr", () => {
  describe("常见网段命中", () => {
    it("10.0.0.0/8 命中内网 10.x.x.x", () => {
      expect(isInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
      expect(isInCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
    });

    it("192.168.0.0/16 命中 192.168.x.x", () => {
      expect(isInCidr("192.168.1.1", "192.168.0.0/16")).toBe(true);
      expect(isInCidr("192.168.254.254", "192.168.0.0/16")).toBe(true);
    });

    it("172.16.0.0/12 命中 172.16-172.31", () => {
      expect(isInCidr("172.20.5.1", "172.16.0.0/12")).toBe(true);
      expect(isInCidr("172.31.255.255", "172.16.0.0/12")).toBe(true);
    });
  });

  describe("不命中", () => {
    it("10.0.0.0/8 不命中 11.x、公网 IP", () => {
      expect(isInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("8.8.8.8", "10.0.0.0/8")).toBe(false);
    });

    it("192.168.0.0/16 不命中 192.169.0.1", () => {
      expect(isInCidr("192.169.0.1", "192.168.0.0/16")).toBe(false);
    });

    it("172.16.0.0/12 不命中 172.32.0.1", () => {
      expect(isInCidr("172.32.0.1", "172.16.0.0/12")).toBe(false);
    });
  });

  describe("边界（前缀 0、/32）", () => {
    it("0.0.0.0/0 命中任意 IP", () => {
      expect(isInCidr("0.0.0.0", "0.0.0.0/0")).toBe(true);
      expect(isInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
      expect(isInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
    });

    it("/32 仅精确命中单个 IP", () => {
      expect(isInCidr("10.1.2.3", "10.1.2.3/32")).toBe(true);
      expect(isInCidr("10.1.2.4", "10.1.2.3/32")).toBe(false);
      expect(isInCidr("10.1.2.3", "10.1.2.4/32")).toBe(false);
    });

    it("网段/32 边界相邻 IP 不命中", () => {
      expect(isInCidr("203.0.113.5", "203.0.113.0/24")).toBe(true);
      expect(isInCidr("203.0.114.0", "203.0.113.0/24")).toBe(false);
    });

    it("非规范网段（网络位含主机位）仍按前缀匹配", () => {
      expect(isInCidr("10.9.9.9", "10.1.0.0/8")).toBe(true);
    });
  });

  describe("非法输入返回 false（不抛错）", () => {
    it("非法 IP 返回 false", () => {
      expect(isInCidr("999.1.1.1", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("1.2.3", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("1.2.3.4.5", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("a.b.c.d", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("256.1.1.1", "10.0.0.0/8")).toBe(false);
    });

    it("非法 CIDR 返回 false", () => {
      expect(isInCidr("10.1.1.1", "10.0.0.0")).toBe(false); // 无前缀
      expect(isInCidr("10.1.1.1", "10.0.0.0/33")).toBe(false); // 前缀超界
      expect(isInCidr("10.1.1.1", "10.0.0.0/-1")).toBe(false);
      expect(isInCidr("10.1.1.1", "10.0.0.0/8/8")).toBe(false);
      expect(isInCidr("10.1.1.1", "not-a-cidr")).toBe(false);
      expect(isInCidr("10.1.1.1", "")).toBe(false);
    });

    it("IP 与 CIDR 均非法返回 false", () => {
      expect(isInCidr("bad-ip", "bad-cidr")).toBe(false);
    });
  });
});

describe("isInAnyCidr（多网段）", () => {
  const CIDRS = ["10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12"];

  it("命中任一网段返回 true", () => {
    expect(isInAnyCidr("10.1.2.3", CIDRS)).toBe(true);
    expect(isInAnyCidr("192.168.0.5", CIDRS)).toBe(true);
    expect(isInAnyCidr("172.25.1.1", CIDRS)).toBe(true); // 命中最后一个网段
  });

  it("都不命中返回 false", () => {
    expect(isInAnyCidr("8.8.8.8", CIDRS)).toBe(false);
    expect(isInAnyCidr("203.0.113.9", CIDRS)).toBe(false);
  });

  it("空网段表返回 false", () => {
    expect(isInAnyCidr("10.1.2.3", [])).toBe(false);
  });

  it("含非法网段时忽略该网段", () => {
    expect(isInAnyCidr("10.1.2.3", ["bad-cidr", "10.0.0.0/8"])).toBe(true);
    expect(isInAnyCidr("8.8.8.8", ["bad-cidr", "10.0.0.0/8"])).toBe(false);
  });
});