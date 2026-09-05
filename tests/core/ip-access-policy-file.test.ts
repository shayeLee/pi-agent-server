import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IP_POLICY_FILE_MAX_BYTES,
  loadIpAccessPolicy,
  readIpAccessPolicyFile,
} from "../../src/core/ip-access-policy-file.js";
import { parseIpAccessEnv, type IpAccessEnvConfig } from "../../src/core/ip-access-config.js";

const VALID_POLICY = JSON.stringify({ version: 1, ips: [{ ip: "203.0.113.7", role: "admin" }] });

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ip-policy-test-"));
  chmodSync(dir, 0o700);
  tmpDirs.push(dir);
  return dir;
}

function writePolicy(dir: string, name = "policy.json", content = VALID_POLICY, mode = 0o600): string {
  const file = path.join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, mode);
  return file;
}

function envWith(policyFile: string | undefined): IpAccessEnvConfig {
  return parseIpAccessEnv({
    PI_ALLOWED_CLIENT_CIDRS: "203.0.113.0/24",
    PI_IP_ACCESS_POLICY_FILE: policyFile,
  });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readIpAccessPolicyFile：安全加载", () => {
  it("合法文件（0600）完整读出", () => {
    const file = writePolicy(makeDir());
    expect(readIpAccessPolicyFile(file)).toBe(VALID_POLICY);
  });

  it("相对路径拒绝", () => {
    expect(() => readIpAccessPolicyFile("relative/policy.json")).toThrow("绝对路径");
  });

  it("不存在/目录/符号链接拒绝", () => {
    const dir = makeDir();
    expect(() => readIpAccessPolicyFile(path.join(dir, "nope.json"))).toThrow("不可访问");
    expect(() => readIpAccessPolicyFile(dir)).toThrow("普通文件");
    const target = writePolicy(dir, "target.json");
    const link = path.join(dir, "link.json");
    symlinkSync(target, link);
    expect(() => readIpAccessPolicyFile(link)).toThrow("符号链接");
  });

  it("硬链接（nlink>1）拒绝", () => {
    const dir = makeDir();
    const file = writePolicy(dir, "a.json");
    linkSync(file, path.join(dir, "b.json"));
    expect(() => readIpAccessPolicyFile(file)).toThrow("单一硬链接");
  });

  it("任何 group/world 权限位拒绝（0600 之外都拒）", () => {
    const dir = makeDir();
    for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777, 0o660, 0o600]) {
      const file = writePolicy(dir, `m${mode.toString(8)}.json`, VALID_POLICY, mode);
      if (mode === 0o600) {
        expect(readIpAccessPolicyFile(file)).toBe(VALID_POLICY);
      } else {
        expect(() => readIpAccessPolicyFile(file)).toThrow("group/world");
      }
    }
  });

  it("超出大小上限拒绝", () => {
    const dir = makeDir();
    const big = " ".repeat(IP_POLICY_FILE_MAX_BYTES + 1); // 无效 JSON 但先触发大小门
    const file = writePolicy(dir, "big.json", big);
    expect(() => readIpAccessPolicyFile(file)).toThrow("大小上限");
  });

  it("大小上限边界内正常读取（刚好等于上限）", () => {
    const dir = makeDir();
    const content = "x".repeat(IP_POLICY_FILE_MAX_BYTES);
    const file = writePolicy(dir, "exact.json", content);
    expect(readIpAccessPolicyFile(file)).toHaveLength(IP_POLICY_FILE_MAX_BYTES);
  });

  it("空文件读出为空串（解析层随后报 JSON 错）", () => {
    const file = writePolicy(makeDir(), "empty.json", "");
    expect(readIpAccessPolicyFile(file)).toBe("");
  });

  const runAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  describe.skipIf(!runAsRoot)("属主检查（需 root 才能伪造非属主文件）", () => {
    it("非当前用户且非 root 属主拒绝", async () => {
      const { chownSync } = await import("node:fs");
      const dir = makeDir();
      const file = writePolicy(dir);
      // euid 为 root 时把属主转给 12345：既非 root 也非当前用户（非 root 环境的 euid 不可能等于 12345 同时又是 root 场景被跳过）
      chownSync(file, 12345, 12345);
      expect(() => readIpAccessPolicyFile(file)).toThrow("当前用户或 root");
    });
  });
});

describe("loadIpAccessPolicy：环境配置组装", () => {
  it("未配置文件 → null", () => {
    expect(loadIpAccessPolicy(envWith(undefined))).toBeNull();
  });

  it("配置了文件 → 安全读取 + 严格解析 + CIDR 覆盖校验", () => {
    const file = writePolicy(makeDir());
    const policy = loadIpAccessPolicy(envWith(file));
    expect(policy).not.toBeNull();
    expect(policy!.byIp.get("203.0.113.7")?.role).toBe("admin");
  });

  it("策略条目超出允许 CIDR → failfast（死配置）", () => {
    const dir = makeDir();
    const file = writePolicy(dir, "out.json", JSON.stringify({ version: 1, ips: [{ ip: "8.8.8.8" }] }));
    expect(() => loadIpAccessPolicy(envWith(file))).toThrow("不在 PI_ALLOWED_CLIENT_CIDRS 范围内");
  });

  it("非法 JSON 策略 → failfast", () => {
    const file = writePolicy(makeDir(), "bad.json", "{ not json");
    expect(() => loadIpAccessPolicy(envWith(file))).toThrow("不是合法 JSON");
  });
});