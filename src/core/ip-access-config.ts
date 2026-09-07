// WP5D-1 IP access policy core：环境变量/配置解析（纯函数，不读 process.env）。
//
// 冻结契约（docs/ip-rbac-design.md）：
// - PI_ALLOWED_CLIENT_CIDRS：显式必填（无默认），逗号分隔的严格 canonical CIDR，
//   不得重复；缺失/空白/非法/非规范一律抛错（failfast）。
// - PI_IP_ACCESS_POLICY_FILE：可选；设置时必须为绝对路径。

import { isAbsolute } from "node:path";
import { parseCidrStrict, type ParsedCidr } from "./cidr.js";

export type IpAccessEnvConfig = {
  /** 严格解析后的允许客户端 CIDR（canonical，无重复） */
  readonly allowedClientCidrs: readonly ParsedCidr[];
  /** canonical 文本，仅供日志/展示 */
  readonly allowedClientCidrTexts: readonly string[];
  /** 可选策略文件绝对路径；未配置为 undefined */
  readonly policyFile: string | undefined;
};

/**
 * 解析 WP5D IP access 环境变量。任何缺失/非法/非规范配置立即抛错（failfast），
 * 错误消息不回显配置值（与既有启动门禁风格一致）。
 */
export function parseIpAccessEnv(env: Readonly<Record<string, string | undefined>>): IpAccessEnvConfig {
  // PI_ALLOWED_CLIENT_CIDRS：显式必填、无默认
  const cidrsValue = env.PI_ALLOWED_CLIENT_CIDRS?.trim();
  if (!cidrsValue) {
    throw new Error("PI_ALLOWED_CLIENT_CIDRS 必须显式设置（无默认值；拒绝 CIDR 外访问）");
  }
  const texts: string[] = [];
  const cidrs: ParsedCidr[] = [];
  const seen = new Set<string>();
  for (const part of cidrsValue.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") {
      throw new Error("PI_ALLOWED_CLIENT_CIDRS 含空白段（必须是逗号分隔的规范 CIDR 列表）");
    }
    let cidr: ParsedCidr;
    try {
      cidr = parseCidrStrict(trimmed);
    } catch {
      throw new Error("PI_ALLOWED_CLIENT_CIDRS 含非法或非规范的 CIDR（必须是规范网络地址/前缀，见 docs/ip-rbac-design.md）");
    }
    if (seen.has(cidr.text)) {
      throw new Error("PI_ALLOWED_CLIENT_CIDRS 含重复网段（请去重后重试）");
    }
    seen.add(cidr.text);
    texts.push(cidr.text);
    cidrs.push(cidr);
  }

  // PI_IP_ACCESS_POLICY_FILE：可选；设置时必须为绝对路径且不含 NUL（文件安全检查见 loader）
  const policyFileRaw = env.PI_IP_ACCESS_POLICY_FILE?.trim();
  let policyFile: string | undefined;
  if (policyFileRaw) {
    if (policyFileRaw.includes("\0")) {
      throw new Error("PI_IP_ACCESS_POLICY_FILE 含 NUL 字符（拒绝）");
    }
    if (!isAbsolute(policyFileRaw)) {
      throw new Error("PI_IP_ACCESS_POLICY_FILE 必须是绝对路径");
    }
    policyFile = policyFileRaw;
  }

  return {
    allowedClientCidrs: cidrs,
    allowedClientCidrTexts: texts,
    policyFile,
  };
}