// WP5D-1 IP access policy core：策略文件安全加载器。
//
// 安全检查清单（docs/ip-rbac-design.md §8，与 backup-core 的文件安全约定一致）：
// - 绝对路径（PI_IP_ACCESS_POLICY_FILE 已在外层校验，这里防御性复核）；
// - lstat 先验：非符号链接、普通文件、单一硬链接（nlink=1）；
// - 属主 = 当前 euid 或 root（部署允许 root 属主文件，如容器挂载配置）；
// - 权限：无任何 group/world 位（mode & 0o077 == 0）；
// - 大小上限：IP_POLICY_FILE_MAX_BYTES（1 MiB），杜绝巨文件 DoS；
// - 打开使用 O_RDONLY | O_NOFOLLOW，随后 fstat 复核同一约束；
// - 按 fstat 报告的大小一次性循环读完，读取后再 fstat：size/mtime/ino/nlink 变化
//   即判定文件在读取期间被替换/修改（稳定读取语义，参照 backup-core fingerprint）。

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { assertPolicyCovered, parseIpAccessPolicy, type IpAccessPolicy } from "./ip-access-policy.js";
import type { IpAccessEnvConfig } from "./ip-access-config.js";

export const IP_POLICY_FILE_MAX_BYTES = 1024 * 1024;

type PolicyFileStat = ReturnType<typeof fstatSync>;

function assertSafeOwner(st: PolicyFileStat, file: string): void {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  const owned = st.uid === euid || st.uid === 0;
  if (!owned) {
    throw new Error(`IP access policy 文件属主必须是当前用户或 root: ${file}`);
  }
}

function assertSafePerms(st: PolicyFileStat, file: string): void {
  if ((Number(st.mode) & 0o077) !== 0) {
    throw new Error(`IP access policy 文件不得有任何 group/world 权限: ${file}`);
  }
}

function assertSafeRegular(st: PolicyFileStat, file: string): void {
  if (!st.isFile() || st.nlink !== 1) {
    throw new Error(`IP access policy 文件必须是单一硬链接的普通文件: ${file}`);
  }
}

/**
 * 读取策略文件文本。所有安全检查失败立即抛错（failfast），
 * 不返回部分内容。错误消息包含路径（路径非凭证），不含文件内容。
 */
export function readIpAccessPolicyFile(file: string): string {
  if (!isAbsolute(file)) {
    throw new Error("IP access policy 文件必须是绝对路径");
  }
  let lstat;
  try {
    lstat = lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`IP access policy 文件不可访问 (${code}): ${file}`);
  }
  if (lstat.isSymbolicLink()) throw new Error(`IP access policy 文件不允许是符号链接: ${file}`);
  assertSafeRegular(lstat, file);
  assertSafeOwner(lstat, file);
  assertSafePerms(lstat, file);
  if (lstat.size > IP_POLICY_FILE_MAX_BYTES) {
    throw new Error(`IP access policy 文件超过大小上限 ${IP_POLICY_FILE_MAX_BYTES} 字节: ${file}`);
  }

  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    assertSafeRegular(before, file);
    assertSafeOwner(before, file);
    assertSafePerms(before, file);
    if (before.size > IP_POLICY_FILE_MAX_BYTES) {
      throw new Error(`IP access policy 文件超过大小上限 ${IP_POLICY_FILE_MAX_BYTES} 字节: ${file}`);
    }
    const buffer = Buffer.allocUnsafe(before.size);
    let position = 0;
    while (position < before.size) {
      const count = readSync(fd, buffer, position, before.size - position, position);
      if (count === 0) {
        throw new Error(`IP access policy 文件读取被截断（读取期间文件被替换）: ${file}`);
      }
      position += count;
    }
    const after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.uid !== before.uid ||
      after.mode !== before.mode
    ) {
      throw new Error(`IP access policy 文件在读取期间发生变化（拒绝使用不一致内容）: ${file}`);
    }
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * 按环境配置加载策略：未配置 PI_IP_ACCESS_POLICY_FILE → null；
 * 配置了则做安全读取 → 严格 JSON v1 解析 → 与允许 CIDR 的一致性校验（failfast）。
 */
export function loadIpAccessPolicy(env: IpAccessEnvConfig): IpAccessPolicy | null {
  if (!env.policyFile) return null;
  const text = readIpAccessPolicyFile(env.policyFile);
  const policy = parseIpAccessPolicy(text);
  assertPolicyCovered(policy, env.allowedClientCidrs);
  return policy;
}