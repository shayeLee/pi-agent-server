// WP5D-1/2 IP access policy core：策略类型、严格 JSON v1 解析、纯函数解析器与
// Bearer token 校验助手（设计见 docs/ip-rbac-design.md）。
//
// 本模块是纯函数（无 fs、无 IO、无日志）；WP5D-2 起由 src/server/network-admission.ts 接线到
// HTTP（全局 onRequest admission）与启动路径（requireIpAccessRuntimeConfig 运行时校验）。
// 冻结语义（2026-02 用户新决策：内网不做 workspace 强制，workspace 安全延期至公网暴露前）：
// - 直接 socket IP 为准；一个 IP = 一个用户（身份键 = canonical IP 文本）。
// - CIDR 外一律 deny；CIDR 内未登记默认 role=user、token off（无任何 workspace 概念）。
// - 可选策略文件中精确 IP 覆盖 role/disabled/tokenRequired/token sha256。
// - 策略条目只允许 ip/role/disabled/tokenRequired/tokens，未知字段 failfast；
//   IP-RBAC 不限制 cwd 或 Agent 工具的绝对路径/OS 权限，不是 sandbox；公网暴露禁止，需未来
//   OIDC/IAM + workspace/sandbox 设计。
// - token 只保存 sha256:<64 小写 hex>，全文件全局唯一；tokenRequired 必须有 hash，
//   未启用 tokenRequired 的条目不得携带 hash；token 绑定精确 IP，不换绑、不迁移。
// - 规则异常一律抛错（failfast），token 明文与哈希永不进入日志（此处无日志）。

import { createHash, timingSafeEqual } from "node:crypto";
import { parseIpStrict, type ParsedCidr, cidrContains, type ParsedIp } from "./cidr.js";

// ---------------------------------------------------------------------------
// 角色与常量

export const IP_ACCESS_POLICY_VERSION = 1;

/** 已知角色集（建议矩阵见 docs/ip-rbac-design.md §6；具体端点权限在 WP5D-2 接线时收敛）。 */
export const IP_ROLES = ["admin", "user", "viewer", "operator"] as const;
export type IpRole = (typeof IP_ROLES)[number];

export const DEFAULT_IP_ROLE: IpRole = "user";
export const TOKEN_HASH_PREFIX = "sha256:";
const TOKEN_HASH_RE = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// 类型

// ---------------------------------------------------------------------------
// 受限 JSON 解析（策略文件专用）

/** 嵌套深度上限（策略 schema 深度 ≤ 4；深层文档视为 DoS 输入拒绝）。 */
const MAX_JSON_DEPTH = 64;

/**
 * 受限 JSON 解析：完整语法校验 + 任意对象层级重复 key 一律拒绝。
 * 不能用 JSON.parse：后者对重复 key 静默“后者覆盖前者”，会掩盖 top/user/token 对象
 * 中的歧义输入。本解析器只服务策略文件 schema（对象/数组/字符串/数字/布尔/null），
 * 深度有限制；输入大小由 loader（IP_POLICY_FILE_MAX_BYTES）控制。
 * 所有错误消息不回显输入内容或 key 名（脱敏）。
 */
function parsePolicyJson(text: string): unknown {
  let pos = 0;
  const n = text.length;

  // 用函数声明而非箭头常量：TS 7 的 CFA 只对声明形式的 never 返回做终止判定
  function fail(): never {
    throw new Error("IP access policy 文件不是合法 JSON");
  }
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";

  const skipWs = (): void => {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos += 1;
      else return;
    }
  };

  const parseString = (): string => {
    pos += 1; // 当前字符已确认是 '"'
    let out = "";
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 0x22 /* " */) {
        pos += 1;
        return out;
      }
      if (c < 0x20) fail(); // 未转义控制字符非法
      if (c === 0x5c /* \ */) {
        pos += 1;
        if (pos >= n) fail();
        const e = text[pos]!;
        pos += 1;
        if (e === '"' || e === "\\" || e === "/") out += e;
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
        } else fail();
        continue;
      }
      out += text[pos]!; // 普通字符（含多字节 UTF-8；text 已由 loader 按 utf8 解码）
      pos += 1;
    }
    fail();
  };

  const parseNumber = (): number => {
    const start = pos;
    if (text[pos] === "-") pos += 1;
    if (pos >= n) fail();
    if (text[pos] === "0") {
      pos += 1;
    } else if (isDigit(text[pos]!)) {
      while (pos < n && isDigit(text[pos]!)) pos += 1;
    } else fail();
    if (text[pos] === ".") {
      pos += 1;
      if (pos >= n || !isDigit(text[pos]!)) fail();
      while (pos < n && isDigit(text[pos]!)) pos += 1;
    }
    if (text[pos] === "e" || text[pos] === "E") {
      pos += 1;
      if (text[pos] === "+" || text[pos] === "-") pos += 1;
      if (pos >= n || !isDigit(text[pos]!)) fail();
      while (pos < n && isDigit(text[pos]!)) pos += 1;
    }
    return Number(text.slice(start, pos)); // 语法已保证是合法 JSON 数字
  };

  const parseValue = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) fail();
    skipWs();
    if (pos >= n) fail();
    const c = text[pos]!;
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === '"') return parseString();
    if (c === "-" || isDigit(c)) return parseNumber();
    if (text.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      return null;
    }
    fail();
  };

  const parseObject = (depth: number): Record<string, unknown> => {
    pos += 1; // {
    // 用 null 原型对象：key 为 "__proto__"/"constructor" 时也只是普通自有字段，无原型污染
    const obj: Record<string, unknown> = Object.create(null);
    skipWs();
    if (pos < n && text[pos] === "}") {
      pos += 1;
      return obj;
    }
    for (;;) {
      skipWs();
      if (pos >= n || text[pos] !== '"') fail();
      const key = parseString();
      if (Object.hasOwn(obj, key)) {
        throw new Error("IP access policy 文件含重复字段（任意对象内 key 必须唯一）");
      }
      skipWs();
      if (pos >= n || text[pos] !== ":") fail();
      pos += 1;
      obj[key] = parseValue(depth + 1);
      skipWs();
      if (pos >= n) fail();
      if (text[pos] === ",") {
        pos += 1;
        continue;
      }
      if (text[pos] === "}") {
        pos += 1;
        return obj;
      }
      fail();
    }
  };

  const parseArray = (depth: number): unknown[] => {
    pos += 1; // [
    const arr: unknown[] = [];
    skipWs();
    if (pos < n && text[pos] === "]") {
      pos += 1;
      return arr;
    }
    for (;;) {
      arr.push(parseValue(depth + 1));
      skipWs();
      if (pos >= n) fail();
      if (text[pos] === ",") {
        pos += 1;
        continue;
      }
      if (text[pos] === "]") {
        pos += 1;
        return arr;
      }
      fail();
    }
  };

  const value = parseValue(0);
  skipWs();
  if (pos !== n) fail(); // 尾随非空白内容拒绝
  return value;
}

/** 策略文件中一个精确 IP 条目（解析后，所有字段已校验）。 */
export type IpAccessEntry = {
  /** canonical IP 文本（IPv4-mapped 已归一为 v4）；全文件唯一 */
  ip: string;
  role: IpRole;
  disabled: boolean;
  /** 为 true 时请求必须出示绑定该 IP 的 Bearer token */
  tokenRequired: boolean;
  /** sha256:<64 小写 hex>；仅当 tokenRequired 时非空 */
  readonly tokenHashes: readonly string[];
};

export type IpAccessPolicy = {
  version: typeof IP_ACCESS_POLICY_VERSION;
  readonly entries: readonly IpAccessEntry[];
  /** canonical IP 文本 → 条目 */
  readonly byIp: ReadonlyMap<string, IpAccessEntry>;
};

/** 解析后的放行画像（per-IP，一个 IP = 一个用户）。 */
export type IpAccessProfile = {
  ip: string;
  role: IpRole;
  tokenRequired: boolean;
  /** 绑定该 IP 的 token 哈希（敏感，只用于校验，绝不记录日志） */
  readonly tokenHashes: readonly string[];
  /** 策略文件中是否存在该精确 IP 条目 */
  registered: boolean;
};

/** 可安全进日志的画像视图（不含 tokenHashes）。 */
export type IpAccessProfilePublic = {
  ip: string;
  role: IpRole;
  tokenRequired: boolean;
  registered: boolean;
};

export type IpAccessVerdict =
  | { verdict: "denied"; reason: "outside-cidr" | "disabled"; ip: string }
  | { verdict: "allowed"; ip: string; profile: IpAccessProfile };

export type IpAccessResolveInput = {
  /** 已严格解析的 PI_ALLOWED_CLIENT_CIDRS */
  readonly allowedClientCidrs: readonly ParsedCidr[];
  /** null = 未配置策略文件 */
  readonly policy: IpAccessPolicy | null;
};

// ---------------------------------------------------------------------------
// 严格 JSON v1 解析

const ENTRY_KEYS = new Set(["ip", "role", "disabled", "tokenRequired", "tokens"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析策略文件 JSON 文本（version 1）。JSON 语法由受限解析器完整校验（任意对象层级
 * 重复 key 拒绝，不用 JSON.parse 的覆盖语义）；所有规则异常与类型错误一律抛错（failfast），
 * 错误消息不含 token 哈希值或任何输入内容（脱敏）。
 */
export function parseIpAccessPolicy(jsonText: string): IpAccessPolicy {
  const raw = parsePolicyJson(jsonText);
  if (!isPlainObject(raw)) throw new Error("IP access policy 顶层必须是 JSON 对象");
  const topKeys = Object.keys(raw);
  if (topKeys.length !== 2 || !topKeys.includes("version") || !topKeys.includes("ips")) {
    throw new Error("IP access policy 顶层只允许 version 与 ips 两个字段");
  }
  if (raw.version !== IP_ACCESS_POLICY_VERSION) {
    throw new Error(`IP access policy version 必须为 ${IP_ACCESS_POLICY_VERSION}（数字）`);
  }
  if (!Array.isArray(raw.ips)) throw new Error("IP access policy ips 必须是数组");
  if (raw.ips.length === 0) throw new Error("IP access policy ips 不得为空（无精确 IP 时不要配置策略文件）");

  const entries: IpAccessEntry[] = [];
  const ipSeen = new Set<string>();
  const tokenSeen = new Set<string>();

  raw.ips.forEach((entryRaw, index) => {
    const at = `ips[${index}]`;
    if (!isPlainObject(entryRaw)) throw new Error(`${at} 必须是对象`);
    const keys = Object.keys(entryRaw);
    for (const key of keys) {
      if (!ENTRY_KEYS.has(key)) throw new Error(`${at} 含未知字段 ${key}`);
    }

    // ip
    if (typeof entryRaw.ip !== "string") throw new Error(`${at}.ip 必须是非空 IP 字符串`);
    let ipParsed: ParsedIp;
    try {
      ipParsed = parseIpStrict(entryRaw.ip);
    } catch {
      throw new Error(`${at}.ip 不是规范的 IP 文本（IPv4-mapped 请写归一后的 v4 形式）`);
    }
    if (ipSeen.has(ipParsed.text)) throw new Error(`${at}.ip 重复：一个精确 IP 只能有一条策略`);
    ipSeen.add(ipParsed.text);

    // role
    let role: IpRole = DEFAULT_IP_ROLE;
    if (entryRaw.role !== undefined) {
      if (typeof entryRaw.role !== "string" || !(IP_ROLES as readonly string[]).includes(entryRaw.role)) {
        throw new Error(`${at}.role 必须是已知角色之一：${IP_ROLES.join("/")}`);
      }
      role = entryRaw.role as IpRole;
    }

    // disabled / tokenRequired
    if (entryRaw.disabled !== undefined && typeof entryRaw.disabled !== "boolean") {
      throw new Error(`${at}.disabled 必须是布尔值`);
    }
    if (entryRaw.tokenRequired !== undefined && typeof entryRaw.tokenRequired !== "boolean") {
      throw new Error(`${at}.tokenRequired 必须是布尔值`);
    }
    const disabled = entryRaw.disabled === true;
    const tokenRequired = entryRaw.tokenRequired === true;

    // disabled 组合严格：不得携带任何授权字段（避免互相矛盾的死配置）
    if (disabled) {
      if (entryRaw.role !== undefined) throw new Error(`${at} 为 disabled 时不得同时设置 role`);
      if (entryRaw.tokenRequired !== undefined) throw new Error(`${at} 为 disabled 时不得同时设置 tokenRequired`);
      if (entryRaw.tokens !== undefined) throw new Error(`${at} 为 disabled 时不得同时设置 tokens`);
    }

    // tokens：tokenRequired ⇔ 非空 tokens（"off 不得 hash"）
    let tokenHashes: string[] = [];
    if (entryRaw.tokens !== undefined) {
      if (!Array.isArray(entryRaw.tokens)) throw new Error(`${at}.tokens 必须是字符串数组`);
      if (!tokenRequired) throw new Error(`${at} 未启用 tokenRequired 时不得提供 tokens`);
      if (entryRaw.tokens.length === 0) throw new Error(`${at}.tokens 不得为空（tokenRequired 必须至少绑定一个 hash）`);
      for (let i = 0; i < entryRaw.tokens.length; i++) {
        const hash = entryRaw.tokens[i];
        if (typeof hash !== "string" || !TOKEN_HASH_RE.test(hash)) {
          throw new Error(`${at}.tokens[${i}] 必须是 sha256:<64 位小写 hex>`);
        }
        if (tokenSeen.has(hash)) {
          throw new Error(`${at}.tokens[${i}] 与文件中其他条目的 token hash 重复（token 全局唯一、不换绑）`);
        }
        tokenSeen.add(hash);
        tokenHashes.push(hash);
      }
    } else if (tokenRequired) {
      throw new Error(`${at} 为 tokenRequired 时必须提供非空 tokens（sha256:<64 位小写 hex>）`);
    }

    entries.push({
      ip: ipParsed.text,
      role,
      disabled,
      tokenRequired,
      tokenHashes,
    });
  });

  const byIp = new Map(entries.map((entry) => [entry.ip, entry]));
  return { version: IP_ACCESS_POLICY_VERSION, entries, byIp };
}

/** 策略一致性校验（load 时 failfast）：所有精确 IP 必须落在允许 CIDR 内，否则是死配置。 */
export function assertPolicyCovered(policy: IpAccessPolicy, allowedCidrs: readonly ParsedCidr[]): void {
  for (const entry of policy.entries) {
    const ip = parseIpStrict(entry.ip);
    if (!allowedCidrs.some((cidr) => cidrContains(cidr, ip))) {
      throw new Error(`IP access policy 中的精确 IP ${entry.ip} 不在 PI_ALLOWED_CLIENT_CIDRS 范围内（死配置，failfast）`);
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数解析器

/** 解析请求来源 IP 的访问决策；ip 必须是合法 socket IP 文本（内部 canonical 归一）。 */
export function resolveIpAccess(input: IpAccessResolveInput, ipText: string): IpAccessVerdict {
  const ip = parseIpStrict(ipText);
  return resolveIpAccessParsed(input, ip);
}

/** parseIpStrict 已完成的内部路径（接线层可复用已解析 IP）。 */
export function resolveIpAccessParsed(input: IpAccessResolveInput, ip: ParsedIp): IpAccessVerdict {
  if (!input.allowedClientCidrs.some((cidr) => cidrContains(cidr, ip))) {
    return { verdict: "denied", reason: "outside-cidr", ip: ip.text };
  }
  const entry = input.policy?.byIp.get(ip.text);
  if (entry !== undefined) {
    if (entry.disabled) return { verdict: "denied", reason: "disabled", ip: ip.text };
    return {
      verdict: "allowed",
      ip: ip.text,
      profile: {
        ip: ip.text,
        role: entry.role,
        tokenRequired: entry.tokenRequired,
        tokenHashes: entry.tokenHashes,
        registered: true,
      },
    };
  }
  // CIDR 内未登记：默认 profile
  return {
    verdict: "allowed",
    ip: ip.text,
    profile: {
      ip: ip.text,
      role: DEFAULT_IP_ROLE,
      tokenRequired: false,
      tokenHashes: [],
      registered: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Bearer token 校验助手（纯函数；常量时间比较；不产生任何日志/输出）

/** 计算 Bearer token 的存储哈希：sha256:<64 位小写 hex>。 */
export function hashBearerToken(token: string): string {
  return `${TOKEN_HASH_PREFIX}${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** 常量时间比较：存储 hash（sha256:…）与出示 token 的哈希。存储格式非法一律 false。
 * 两段比较文本长度固定（71 字符），timingSafeEqual 前先防御性校验长度。 */
export function tokenHashMatches(storedHash: string, presentedToken: string): boolean {
  return tokenHashMatchesComputed(storedHash, hashBearerToken(presentedToken));
}

/** 内部：与已计算的出示哈希做定长常量时间比较（verifyProfileToken 只哈希一次后逐项复用）。 */
function tokenHashMatchesComputed(storedHash: string, presentedHash: string): boolean {
  if (!TOKEN_HASH_RE.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, "ascii");
  const actual = Buffer.from(presentedHash, "ascii");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * 校验出示的 Bearer token 是否满足画像要求：
 * - tokenRequired=false：不要求 token，恒 true（出示与否不影响）。
 * - tokenRequired=true：必须出示且命中该 IP 绑定的任一 hash（IP binding；
 *   token 只绑定精确 IP，不换绑、不迁移）。
 * 常量工作量语义（准确表述）：出示 token **只哈希一次**；随后与画像上**全部** hash
 * 逐项做定长常量时间比较，**遍历全部条目不短路**、累积匹配结果——对固定画像，
 * 比较工作量与命中位置、命中与否无关（总工作量随画像 hash 条数线性变化）。
 */
export function verifyProfileToken(profile: Pick<IpAccessProfile, "tokenRequired" | "tokenHashes">, presented: string | undefined): boolean {
  if (!profile.tokenRequired) return true;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const presentedHash = hashBearerToken(presented);
  let matched = false;
  for (const hash of profile.tokenHashes) {
    if (tokenHashMatchesComputed(hash, presentedHash)) matched = true;
  }
  return matched;
}

/** 可安全进日志的画像视图（不含 tokenHashes，杜绝哈希/明文泄漏）。 */
export function publicProfile(profile: IpAccessProfile): IpAccessProfilePublic {
  return {
    ip: profile.ip,
    role: profile.role,
    tokenRequired: profile.tokenRequired,
    registered: profile.registered,
  };
}