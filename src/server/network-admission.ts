// WP5D-2 HTTP 网络准入接线：全局 onRequest admission（覆盖探针与 /v1 全部路由）。
//
// 冻结语义（docs/ip-rbac-design.md §2，接线后生效）：
// - 身份 = 直接 TCP 对端 IP：一律读 request.raw.socket.remoteAddress，
//   不使用 X-Forwarded-For，也不使用 request.ip（后者受 trustProxy 影响）；
// - 所有 HTTP 路由先过 CIDR/disabled gate：CIDR 外 / disabled / socket IP 不可解析 → 403；
// - /v1 与 /metrics 且画像 tokenRequired：实际请求与非预检 OPTIONS 缺失/错误 Bearer token → 401；
//   合规 CORS 预检（OPTIONS + Origin + Access-Control-Request-Method）免 token，随后交给 CORS origin policy；
// - /health、/readyz 仅 IP gate，不做 token/role 判定（存活/就绪探针任意 admitted）；
//   /metrics 与 /v1 的 role 授权由 WP5D-3 矩阵执行（metrics 仅 admin/operator）；
// - 身份 = canonical IP（IPv4-mapped 一律归一为 v4）；token 不能绕过 CIDR。
//
// 契约（clean auth contract）：
// - createAdmission 返回 per-request 决策：allowed 携带 user（canonical IP 身份）与
//   access（public profile：ip/role/tokenRequired/registered，**无 token hashes**）；
// - request.user / request.access 是唯一注入点；token 明文与哈希绝不进日志（日志只带
//   subjectHash）；401/403 响应体不含原始 IP/token/path。cwd 与 Agent 工具的绝对路径/
//   OS 权限不在 IP-RBAC 范围内（不是 sandbox）。

import type { FastifyRequest } from "fastify";
import { parseCidrStrict, parseIpStrict, type ParsedCidr } from "../core/cidr.js";
import {
  assertPolicyCovered,
  IP_ACCESS_POLICY_VERSION,
  IP_ROLES,
  publicProfile,
  resolveIpAccessParsed,
  verifyProfileToken,
  type IpAccessEntry,
  type IpAccessPolicy,
  type IpAccessProfilePublic,
  type IpAccessResolveInput,
} from "../core/ip-access-policy.js";
import type { UserIdentity } from "../core/user-identity.js";

/** 注入 request.access 的访问画像（public：无 token hashes，可进日志/契约层）。 */
export type AccessProfile = IpAccessProfilePublic;

export type AdmissionResult =
  | {
      verdict: "allowed";
      /** canonical IP 身份（一个 IP = 一个用户） */
      user: UserIdentity;
      /** public access profile（无 token hashes；role 供 WP5D-3 路由授权使用，不进日志） */
      access: AccessProfile;
    }
  | { verdict: "denied"; reason: "bad-ip" | "outside-cidr" | "disabled"; statusCode: 403 }
  | { verdict: "denied"; reason: "token-required"; statusCode: 401 };

export type Admission = (request: FastifyRequest) => AdmissionResult;

/**
 * token gate 覆盖范围（WP5D-3 reviewer 语义）：
 * - /v1 全部路径：tokenRequired 画像必须出示绑定该 IP 的 Bearer token；
 * - /metrics：运维面，实际 GET/非预检 OPTIONS 同样要求 token（role 为 admin/operator）；
 * - /health、/readyz：纯存活/就绪探针，永不需要 token（任意 admitted IP/role）。
 * 合规 CORS 预检在所有路径上免 token。
 */
function isTokenGatedUrl(rawUrl: string): boolean {
  const path = rawUrl.split("?")[0]!;
  return path === "/v1" || path.startsWith("/v1/") || path === "/metrics";
}

/**
 * 只有浏览器 CORS 预检才可在 tokenRequired 的 /v1 上免 token：
 * OPTIONS + 非空 Origin + 非空 Access-Control-Request-Method。
 * Origin policy 仍由 @fastify/cors 最终判定；不完整的 OPTIONS 不得获得豁免。
 */
function isCorsPreflight(request: FastifyRequest): boolean {
  return request.method === "OPTIONS"
    && typeof request.headers.origin === "string"
    && request.headers.origin.length > 0
    && typeof request.headers["access-control-request-method"] === "string"
    && request.headers["access-control-request-method"].length > 0;
}

/** 提取 Bearer token（RFC 7235，scheme 大小写不敏感）；非 Bearer / 缺失返回 undefined。 */
export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header);
  return match ? match[1] : undefined;
}

/** 读取直接 TCP 对端 IP（不信任任何代理头）；undefined/空 → null（failclosed）。 */
function socketPeerIpText(request: FastifyRequest): string | null {
  const raw = (request.raw.socket as { remoteAddress?: unknown } | undefined)?.remoteAddress;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * 全局准入工厂：CIDR/disabled gate + token gate（/v1 与 /metrics；/health、/readyz 免 token）。
 * 纯同步、无 IO、不产生任何日志；token hashes 只在该闭包内流通。
 */
export function createAdmission(input: IpAccessResolveInput): Admission {
  return (request) => {
    const raw = socketPeerIpText(request);
    if (raw === null) {
      // unknown socket IP：failclosed 403（不泄漏任何信息）
      return { verdict: "denied", reason: "bad-ip", statusCode: 403 };
    }
    let parsed: ParsedIpLike;
    try {
      parsed = parseIpStrict(raw); // IPv4-mapped → 归一 v4
    } catch {
      return { verdict: "denied", reason: "bad-ip", statusCode: 403 };
    }
    const verdict = resolveIpAccessParsed(input, parsed);
    if (verdict.verdict === "denied") {
      return { verdict: "denied", reason: verdict.reason, statusCode: 403 };
    }
    const profile = verdict.profile;
    // token gate 作用于 /v1 与 /metrics；仅合规 CORS 预检免 token，随后仍交给 CORS origin policy。
    // 非预检 OPTIONS 与实际请求（GET）仍必须通过 token gate。
    if (profile.tokenRequired && isTokenGatedUrl(request.url) && !isCorsPreflight(request)) {
      const presented = extractBearerToken(request.headers.authorization);
      if (!verifyProfileToken(profile, presented)) {
        return { verdict: "denied", reason: "token-required", statusCode: 401 };
      }
    }
    return {
      verdict: "allowed",
      user: { kind: "ip", ip: profile.ip },
      access: publicProfile(profile), // 剥掉 tokenHashes：契约层只见 public profile
    };
  };
}

// ---------------------------------------------------------------------------
// 运行时严格校验（StartConfig.ipAccess / buildApp deps.ipAccess 共用）

type ParsedIpLike = ReturnType<typeof parseIpStrict>;

const RUNTIME_TOKEN_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** Runtime objects are already parsed values, so reject both unknown and missing own fields. */
function assertExactOwnKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      throw new Error(`${label} 含未知字段 ${typeof key === "string" ? key : "symbol"}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} 缺少必要字段`);
    }
  }
}

function assertParsedCidrShape(item: unknown): ParsedCidr {
  if (typeof item !== "object" || item === null) {
    throw new Error("ipAccess.allowedClientCidrs 含非法 CIDR 条目");
  }
  const c = item as Record<string, unknown>;
  assertExactOwnKeys(c, ["family", "prefix", "bytes", "text"], "ipAccess.allowedClientCidrs 条目");
  if (c.family !== "v4" && c.family !== "v6") {
    throw new Error("ipAccess.allowedClientCidrs 含非法 CIDR 条目");
  }
  if (typeof c.prefix !== "number" || !Number.isInteger(c.prefix)) {
    throw new Error("ipAccess.allowedClientCidrs 含非法 CIDR 条目");
  }
  if (typeof c.text !== "string") {
    throw new Error("ipAccess.allowedClientCidrs 含非法 CIDR 条目");
  }
  if (!Array.isArray(c.bytes) || c.bytes.length !== (c.family === "v4" ? 4 : 16) || c.bytes.some((b) => typeof b !== "number")) {
    throw new Error("ipAccess.allowedClientCidrs 含非法 CIDR 条目");
  }
  let reparsed: ParsedCidr;
  try {
    reparsed = parseCidrStrict(c.text);
  } catch {
    throw new Error("ipAccess.allowedClientCidrs 含非法或非规范的 CIDR 条目");
  }
  if (
    reparsed.family !== c.family ||
    reparsed.prefix !== c.prefix ||
    reparsed.bytes.length !== c.bytes.length ||
    reparsed.bytes.some((b, i) => b !== (c.bytes as readonly number[])[i])
  ) {
    throw new Error("ipAccess.allowedClientCidrs 与严格解析结果不一致（拒绝伪造配置）");
  }
  return reparsed;
}

function assertEntryShape(rawEntry: unknown): IpAccessEntry {
  if (typeof rawEntry !== "object" || rawEntry === null) {
    throw new Error("ipAccess.policy 含非法条目");
  }
  const e = rawEntry as Record<string, unknown>;
  assertExactOwnKeys(
    e,
    ["ip", "role", "disabled", "tokenRequired", "tokenHashes"],
    "ipAccess.policy 条目",
  );
  if (typeof e.ip !== "string" || parseIpStrict(e.ip).text !== e.ip) {
    throw new Error("ipAccess.policy 条目 ip 必须是规范 canonical IP 文本");
  }
  if (typeof e.role !== "string" || !(IP_ROLES as readonly string[]).includes(e.role)) {
    throw new Error("ipAccess.policy 条目 role 非法");
  }
  if (typeof e.disabled !== "boolean" || typeof e.tokenRequired !== "boolean") {
    throw new Error("ipAccess.policy 条目 disabled/tokenRequired 必须是布尔值");
  }
  if (!Array.isArray(e.tokenHashes) || e.tokenHashes.some((h) => typeof h !== "string" || !RUNTIME_TOKEN_HASH_RE.test(h))) {
    throw new Error("ipAccess.policy 条目 tokenHashes 非法（必须是 sha256:<64 位小写 hex>）");
  }
  if (e.disabled) {
    if (e.role !== "user" || e.tokenRequired || e.tokenHashes.length !== 0) {
      throw new Error("ipAccess.policy disabled 条目不得携带授权字段（与解析器同一互斥语义）");
    }
  } else if (e.tokenRequired && e.tokenHashes.length === 0) {
    throw new Error("ipAccess.policy tokenRequired 条目必须绑定非空 tokenHashes");
  } else if (!e.tokenRequired && e.tokenHashes.length !== 0) {
    throw new Error("ipAccess.policy 未启用 tokenRequired 的条目不得携带 tokenHashes");
  }
  return {
    ip: e.ip as string,
    role: e.role as IpAccessEntry["role"],
    disabled: e.disabled,
    tokenRequired: e.tokenRequired,
    tokenHashes: e.tokenHashes as readonly string[],
  };
}

/**
 * 严格校验运行时 ipAccess 配置（StartConfig.ipAccess / buildApp deps.ipAccess）：
 * - 缺失/非对象/任何字段非法 → 抛错（failfast，错误消息不回显配置值）；
 * - 旧字段 intranetCidrs/tokens/trustProxy 出现在配置对象上 → 抛错（JS/typed bypass 一律拒绝）；
 * - 策略条目含已移除字段 workspaceRoots → 抛错（同解析器未知字段 failfast 语义）；
 * - 策略条目与允许 CIDR 的一致性（covered）在运行时复核（与 load 语义一致）。
 * 本函数是唯一入口：直接 JS bypass（绕开 main 的 env 解析）同样 fail。
 */
export function requireIpAccessRuntimeConfig(input: unknown): IpAccessResolveInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("ipAccess（网络准入）配置缺失或非法：必须在任何资源创建前提供严格解析的准入配置");
  }
  const o = input as Record<string, unknown>;
  // The resolved runtime contract is intentionally smaller than StartConfig. Check own
  // property presence so undefined-valued removed/unknown fields cannot bypass it.
  for (const legacy of ["intranetCidrs", "tokens", "trustProxy"] as const) {
    if (Object.hasOwn(o, legacy)) {
      throw new Error(`StartConfig 旧字段 ${legacy} 已废弃（WP5D-2 网络准入）：设置即拒绝启动（值不回显）`);
    }
  }
  assertExactOwnKeys(o, ["allowedClientCidrs", "policy"], "ipAccess");
  if (!Array.isArray(o.allowedClientCidrs) || o.allowedClientCidrs.length === 0) {
    throw new Error("ipAccess.allowedClientCidrs 必须是严格的非空 CIDR 数组（缺失/空即拒绝启动）");
  }
  const allowedCidrs = o.allowedClientCidrs.map(assertParsedCidrShape);

  let policy: IpAccessPolicy | null = null;
  if (o.policy === undefined) {
    throw new Error("ipAccess.policy 必须是 null 或解析后的策略对象");
  }
  if (o.policy !== null) {
    if (typeof o.policy !== "object" || Array.isArray(o.policy)) {
      throw new Error("ipAccess.policy 必须是 null 或解析后的策略对象");
    }
    const p = o.policy as Record<string, unknown>;
    assertExactOwnKeys(p, ["version", "entries", "byIp"], "ipAccess.policy");
    if (p.version !== IP_ACCESS_POLICY_VERSION || !Array.isArray(p.entries) || !(p.byIp instanceof Map)) {
      throw new Error("ipAccess.policy 必须是解析后的策略对象（version/entries/byIp）");
    }
    const rawEntries = p.entries as readonly unknown[];
    const byIp = p.byIp as ReadonlyMap<string, unknown>;
    const entries = rawEntries.map(assertEntryShape);
    // 精确 IP 全文件唯一 + token hash 全文件唯一（与解析器同一不换绑语义）；
    // byIp 必须指向同一批条目对象（引用相等，拒绝伪造配置）。
    const ipSeen = new Set<string>();
    const tokenSeen = new Set<string>();
    entries.forEach((entry, index) => {
      if (ipSeen.has(entry.ip)) throw new Error("ipAccess.policy 精确 IP 重复（运行时拒绝）");
      ipSeen.add(entry.ip);
      for (const hash of entry.tokenHashes) {
        if (tokenSeen.has(hash)) throw new Error("ipAccess.policy token hash 重复（运行时拒绝）");
        tokenSeen.add(hash);
      }
      if (byIp.get(entry.ip) !== rawEntries[index]) {
        throw new Error("ipAccess.policy byIp 映射与条目不一致（拒绝伪造配置）");
      }
    });
    if (byIp.size !== entries.length) {
      throw new Error("ipAccess.policy byIp 映射含未知条目（拒绝伪造配置）");
    }
    policy = {
      version: IP_ACCESS_POLICY_VERSION,
      entries,
      byIp: new Map(entries.map((entry) => [entry.ip, entry])),
    };
    assertPolicyCovered(policy, allowedCidrs);
  }

  return { allowedClientCidrs: allowedCidrs, policy };
}

// ---------------------------------------------------------------------------
// 请求级身份挂载点：admission 通过后写入；token hashes 永不挂载到 request。
declare module "fastify" {
  interface FastifyRequest {
    user: UserIdentity;
    access: AccessProfile;
    subjectHash: string;
  }
}