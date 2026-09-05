import { describe, expect, it } from "vitest";
import { parseIpAccessEnv } from "../../src/core/ip-access-config.js";

type Env = Record<string, string | undefined>;

function fullEnv(overrides: Env = {}): Env {
  return {
    PI_ALLOWED_CLIENT_CIDRS: "10.0.0.0/8, 2001:db8::/32",
    ...overrides,
  };
}

describe("parseIpAccessEnv", () => {
  it("完整配置解析成功：canonical 化、去空白段", () => {
    const config = parseIpAccessEnv(fullEnv());
    expect(config.allowedClientCidrTexts).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
    expect(config.allowedClientCidrs).toHaveLength(2);
    expect(config.policyFile).toBeUndefined();
  });

  it("PI_ALLOWED_CLIENT_CIDRS 显式必填、无默认：缺失/空白抛错", () => {
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: undefined }))).toThrow("必须显式设置");
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "" }))).toThrow("必须显式设置");
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "   " }))).toThrow("必须显式设置");
  });

  it("PI_ALLOWED_CLIENT_CIDRS 非法/非规范/重复抛错", () => {
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "10.0.0.0" }))).toThrow(/非法或非规范/);
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "10.1.0.0/8" }))).toThrow(/非法或非规范/); // 主机位非零
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "010.0.0.0/8" }))).toThrow(/非法或非规范/);
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "2001:DB8::/32" }))).toThrow(/非法|非规范/);
    expect(parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "::ffff:1.2.3.0/120" })).allowedClientCidrTexts).toEqual(["1.2.3.0/24"]); // mapped 归一为 v4
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "::ffff:1.2.3.4/120" }))).toThrow(/非法或非规范/); // mapped 主机位非零拒绝
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "10.0.0.0/33" }))).toThrow(/非法或非规范/);
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "bad-cidr" }))).toThrow(/非法或非规范/);
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "10.0.0.0/8,10.0.0.0/8" }))).toThrow("重复");
    expect(() => parseIpAccessEnv(fullEnv({ PI_ALLOWED_CLIENT_CIDRS: "10.0.0.0/8,,192.168.0.0/16" }))).toThrow("空白段");
  });

  it("PI_DEFAULT_WORKSPACE_ROOT 已移除：property presence（含 undefined/空串）固定脱敏拒绝", () => {
    // 当前内网不做 workspace enforcement；已移除配置不能通过任意值绕过启动门禁。
    for (const value of ["/srv/ws/default", "", undefined]) {
      expect(() => parseIpAccessEnv(fullEnv({ PI_DEFAULT_WORKSPACE_ROOT: value }))).toThrow(
        "PI_DEFAULT_WORKSPACE_ROOT 已移除：设置即拒绝启动；当前不做 workspace enforcement",
      );
    }
  });

  it("PI_IP_ACCESS_POLICY_FILE 可选；未设置/空白 → undefined；相对路径与 NUL 拒绝", () => {
    expect(parseIpAccessEnv(fullEnv()).policyFile).toBeUndefined();
    expect(parseIpAccessEnv(fullEnv({ PI_IP_ACCESS_POLICY_FILE: "" })).policyFile).toBeUndefined();
    expect(parseIpAccessEnv(fullEnv({ PI_IP_ACCESS_POLICY_FILE: "   " })).policyFile).toBeUndefined();
    expect(() => parseIpAccessEnv(fullEnv({ PI_IP_ACCESS_POLICY_FILE: "etc/policy.json" }))).toThrow("必须");
    expect(() => parseIpAccessEnv(fullEnv({ PI_IP_ACCESS_POLICY_FILE: "/etc/policy\u0000.json" }))).toThrow("NUL");
    expect(parseIpAccessEnv(fullEnv({ PI_IP_ACCESS_POLICY_FILE: "/etc/pi/ip-access-policy.json" })).policyFile).toBe("/etc/pi/ip-access-policy.json");
  });
});