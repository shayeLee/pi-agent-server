// WP5D-2 测试共享准入配置构造：与生产同一语义（parseIpAccessEnv/loadIpAccessPolicy 之后的结构）。
// 策略一律经 parseIpAccessPolicy 构造，保证测试 fixture 与生产解析器同约束
// （tokenRequired ⇔ 非空 tokens；token 传明文，由 builder 哈希；精确 IP 必须落在允许 CIDR 内）。
// workspaceRoots/PI_DEFAULT_WORKSPACE_ROOT 已移除（2026-02 用户决策：内网不做 workspace 强制）。

import { parseCidrStrict, type ParsedCidr } from "../../src/core/cidr.js";
import {
  hashBearerToken,
  parseIpAccessPolicy,
  type IpAccessPolicy,
  type IpAccessResolveInput,
  type IpRole,
} from "../../src/core/ip-access-policy.js";

/** 测试默认允许网段：覆盖 inject 默认来源 127.0.0.1、双用户 10.0.0.x 与常见内网段。 */
export const TEST_CIDR_TEXTS = ["127.0.0.0/8", "10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12"];

export function parseTestCidrs(texts: readonly string[]): ParsedCidr[] {
  return texts.map((text) => parseCidrStrict(text));
}

export type PolicyEntrySpec = {
  ip: string;
  role?: IpRole;
  disabled?: boolean;
  tokenRequired?: boolean;
  /** 明文 token（builder 负责哈希）；仅当 tokenRequired 时允许 */
  tokens?: string[];
};

/** 经真实 parseIpAccessPolicy 构造策略（与生产加载同约束；token 明文自动哈希）。 */
export function makePolicy(entries: readonly PolicyEntrySpec[]): IpAccessPolicy {
  const ips = entries.map((e) => {
    const tokens = e.tokenRequired ? (e.tokens ?? []) : [];
    return {
      ip: e.ip,
      ...(e.role !== undefined ? { role: e.role } : {}),
      ...(e.disabled === true ? { disabled: true } : {}),
      ...(e.tokenRequired === true ? { tokenRequired: true, tokens: tokens.map(hashBearerToken) } : {}),
    };
  });
  return parseIpAccessPolicy(JSON.stringify({ version: 1, ips }));
}

export function makeTestIpAccess(
  overrides: {
    cidrs?: readonly string[];
    policy?: IpAccessPolicy | null;
  } = {},
): IpAccessResolveInput {
  return {
    allowedClientCidrs: parseTestCidrs(overrides.cidrs ?? TEST_CIDR_TEXTS),
    policy: overrides.policy === undefined ? null : overrides.policy,
  };
}

/** 常用双用户来源 IP（默认测试网段 10.0.0.0/8 内）。 */
export const USER_IP_A = "10.0.0.1";
export const USER_IP_B = "10.0.0.2";
/** CIDR 外的公网来源 IP。 */
export const OUTSIDE_IP = "203.0.113.9";