// IP / CIDR 解析与匹配（needs.md §4.2 内网判定 + WP5D-1 IP access policy core）
//
// 分两层 API：
// 1. legacy 兼容层（旧行为不变）：isInCidr / isInAnyCidr —— IPv4-only，IPv6/
//    IPv4-mapped IPv6/非法输入一律返回 false；前缀按掩码匹配（网段文本的网络位可含主机位，如 10.1.0.0/8）。
// 2. 严格 canonical 层（配置解析用）：parseIpStrict / parseCidrStrict —— 非法或
//    非规范输入直接抛错（failfast），供 PI_ALLOWED_CLIENT_CIDRS / 策略文件使用。
//
// Canonical 语义：
// - IPv4 输出点分十进制；输入允许前导零等非规范形式，输出一律消零（01.2.3.4 → 1.2.3.4）。
// - IPv6 输出 RFC 5952 规范文本（小写、组内无前导零、压缩最左最长全零段）；文本语法严格：
//   “::” 至多一次、除该压缩外不允许任何空组（:::ffff、1::2::3、:1:2:…、…2: 等一律拒绝）、
//   嵌入 IPv4 只能是整个地址的最后一组（1:2:3:4:5:1.2.3.4:: 拒绝；1:2:3:4:5:6:1.2.3.4 合法）。
// - IPv4-mapped（RFC 4291 ::ffff:0:0/96 布局：前 80 bit 全零、第 81–96 bit 全一，即
//   ::ffff:a.b.c.d 或 ::ffff:xxxx:xxxx 十六进制形式）一律归一为 IPv4；
//   ::ffff:0:a.b.c.d 等非该布局形式保持 v6（嵌入 v4 不在地址最后 32 bit）。
//   mapped 形式作为 CIDR 时前缀必须 ≥96，归一并映射为前缀-96；严格层还要求映射出的
//   v4 地址相对有效前缀主机位为零（::ffff:1.2.3.0/120 → 1.2.3.0/24；::ffff:1.2.3.4/120 拒绝）。
// - 严格模式要求输入文本与 canonical 输出完全一致（拒绝前导零/大写/非压缩 v6/主机位非零网段）。
// - 跨族不匹配：归一后的 v4 只与 v4 网段比较，v6 只与 v6 网段比较。

export type IpFamily = "v4" | "v6";

export type ParsedIp = {
  family: IpFamily;
  /** 4（v4）或 16（v6）字节网络序 */
  readonly bytes: readonly number[];
  /** canonical 文本 */
  text: string;
};

export type ParsedCidr = {
  family: IpFamily;
  /** 已按前缀掩码处理后的网络地址字节 */
  readonly bytes: readonly number[];
  prefix: number;
  /** canonical 文本（网络地址/前缀） */
  text: string;
};

const V4_BYTE_COUNT = 4;
const V6_BYTE_COUNT = 16;
const MAX_IP_TEXT_LENGTH = 128;
const MAX_CIDR_TEXT_LENGTH = 160;

// ---------------------------------------------------------------------------
// legacy IPv4-only matching
//
// Keep this parser separate from the new dual-stack parser below. The server's
// existing isInCidr/isInAnyCidr contract is IPv4-only, including rejecting
// IPv6 and IPv4-mapped IPv6 inputs.

function legacyIpToUint32(ip: string): number | null {
  if (typeof ip !== "string") return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function legacyParseCidr(cidr: string): { network: number; prefix: number } | null {
  if (typeof cidr !== "string") return null;
  const slash = cidr.indexOf("/");
  if (slash === -1) return null;
  const ipPart = cidr.slice(0, slash);
  const prefixPart = cidr.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix > 32) return null;
  const network = legacyIpToUint32(ipPart);
  if (network === null) return null;
  return { network, prefix };
}

// ---------------------------------------------------------------------------
// 底层解析

/** 宽松 IPv4 解析：点分十进制，每组 1–3 位数字、≤255；返回 4 字节；非法返回 null。 */
function parseV4Bytes(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== V4_BYTE_COUNT) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * 解析 v6 文本为 16 字节；语法严格校验：
 * - “::” 至多一次（含重叠形式 “:::…”）；
 * - 除这一个压缩外不允许任何空组（开头/结尾冒号、连续冒号均拒绝）；
 * - 嵌入 IPv4 只能是整个地址的最后一组（无压缩时是第 7 组后的 v4；有压缩时只能在 “::” 之后）。
 * 非法返回 null（宽松层语义：调用方不抛错）。
 */
function parseV6Bytes(text: string): number[] | null {
  const t = text.toLowerCase();
  const first = t.indexOf("::");
  if (first !== -1 && t.indexOf("::", first + 1) !== -1) return null; // “::” 至多一次（含重叠 “:::” 与多个压缩）
  let head: string[];
  let tail: string[];
  if (first === -1) {
    if (t.startsWith(":") || t.endsWith(":")) return null; // 无 “::” 时不得有空组
    head = t.split(":");
    tail = [];
  } else {
    const headText = t.slice(0, first);
    const tailText = t.slice(first + 2);
    // 压缩之外不允许空组：head/tail 非空时不得以 “:” 开头或结尾
    if (headText !== "" && (headText.startsWith(":") || headText.endsWith(":"))) return null;
    if (tailText !== "" && (tailText.startsWith(":") || tailText.endsWith(":"))) return null;
    head = headText === "" ? [] : headText.split(":");
    tail = tailText === "" ? [] : tailText.split(":");
  }
  const headWords: number[] = [];
  for (let i = 0; i < head.length; i++) {
    const part = head[i]!;
    if (part.includes(".")) {
      // 嵌入 IPv4 只能是整个地址的最后一组：有 “::” 时（压缩零段在其后）或非最后一组均位置不符
      if (first !== -1 || i !== head.length - 1) return null;
      const v4 = parseV4Bytes(part);
      if (v4 === null) return null;
      headWords.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    headWords.push(parseInt(part, 16));
  }
  const tailWords: number[] = [];
  for (let i = 0; i < tail.length; i++) {
    const part = tail[i]!;
    if (part.includes(".")) {
      // 嵌入 IPv4 必须位于地址末尾（tail 内最后一组）
      if (i !== tail.length - 1) return null;
      const v4 = parseV4Bytes(part);
      if (v4 === null) return null;
      tailWords.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    tailWords.push(parseInt(part, 16));
  }
  const total = headWords.length + tailWords.length;
  if (first === -1) {
    if (total !== 8) return null;
  } else if (total >= 8) {
    return null; // "::" 必须至少压缩一个全零组
  }
  const zeros = 8 - total;
  const words = [...headWords, ...new Array<number>(zeros).fill(0), ...tailWords];
  const bytes: number[] = [];
  for (const word of words) bytes.push((word >> 8) & 0xff, word & 0xff);
  return bytes;
}

/** IPv4-mapped（RFC 4291 ::ffff:0:0/96 布局：bytes[0..9] 全零、bytes[10..11] 全一）归一为 v4 字节；否则返回 null。
 *  注意 ::ffff:0:a.b.c.d 的 ffff 位于 bytes[8..9]，不是 mapped 布局，保持 v6。 */
function mappedToV4(bytes: number[]): number[] | null {
  if (bytes.length !== V6_BYTE_COUNT) return null;
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.slice(12);
}

function renderV4(bytes: readonly number[]): string {
  return bytes.join(".");
}

/** RFC 5952 规范渲染：小写、组内无前导零、压缩最左最长全零段（≥2 组才压缩）。 */
function renderV6(bytes: readonly number[]): string {
  const words: number[] = [];
  for (let i = 0; i < V6_BYTE_COUNT; i += 2) words.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  const hex = (word: number) => word.toString(16);
  if (bestLen >= 2) {
    const left = words.slice(0, bestStart).map(hex).join(":");
    const right = words.slice(bestStart + bestLen).map(hex).join(":");
    return `${left}::${right}`;
  }
  return words.map(hex).join(":");
}

/** 生成 prefix 位网络序掩码字节。 */
function maskBytes(prefix: number, byteCount: number): number[] {
  const mask = new Array<number>(byteCount).fill(0);
  let bits = prefix;
  for (let i = 0; i < byteCount && bits > 0; i++) {
    if (bits >= 8) {
      mask[i] = 0xff;
      bits -= 8;
    } else {
      mask[i] = (0xff << (8 - bits)) & 0xff;
      bits = 0;
    }
  }
  return mask;
}

function masked(bytes: readonly number[], mask: readonly number[]): number[] {
  return bytes.map((b, i) => b & (mask[i] ?? 0xff));
}

function bytesEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// 公共解析 API（宽松：非法返回 null，不抛错）

/** 解析任意合法 IP 文本为规范形式；IPv4-mapped 统一归一为 v4；非法返回 null。 */
export function parseIp(ip: string): ParsedIp | null {
  if (typeof ip !== "string" || ip.length === 0 || ip.length > MAX_IP_TEXT_LENGTH) return null;
  if (ip.includes(":")) {
    const bytes = parseV6Bytes(ip);
    if (bytes === null) return null;
    const mapped = mappedToV4(bytes);
    if (mapped !== null) return { family: "v4", bytes: mapped, text: renderV4(mapped) };
    return { family: "v6", bytes, text: renderV6(bytes) };
  }
  const bytes = parseV4Bytes(ip);
  if (bytes === null) return null;
  return { family: "v4", bytes, text: renderV4(bytes) };
}

/** 解析 CIDR 文本；返回的 network 字节已按前缀掩码、文本为 canonical；非法返回 null。 */
export function parseCidr(cidr: string): ParsedCidr | null {
  if (typeof cidr !== "string" || cidr.length === 0 || cidr.length > MAX_CIDR_TEXT_LENGTH) return null;
  const slash = cidr.indexOf("/");
  if (slash === -1 || cidr.indexOf("/", slash + 1) !== -1) return null;
  const ipPart = cidr.slice(0, slash);
  const prefixPart = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix > 128) return null;
  const raw = parseIp(ipPart);
  if (raw === null) return null;
  if (raw.family === "v4") {
    if (ipPart.includes(":")) {
      // IPv4-mapped 文本形式：前缀必须 ≥96，映射为 v4 前缀减 96
      if (prefix < 96) return null;
      const effective = prefix - 96;
      const net = masked(raw.bytes, maskBytes(effective, V4_BYTE_COUNT));
      return { family: "v4", bytes: net, prefix: effective, text: `${renderV4(net)}/${effective}` };
    }
    if (prefix > 32) return null;
    const net = masked(raw.bytes, maskBytes(prefix, V4_BYTE_COUNT));
    return { family: "v4", bytes: net, prefix, text: `${renderV4(net)}/${prefix}` };
  }
  const net = masked(raw.bytes, maskBytes(prefix, V6_BYTE_COUNT));
  return { family: "v6", bytes: net, prefix, text: `${renderV6(net)}/${prefix}` };
}

/** canonical IP 文本；非法返回 null。 */
export function canonicalIp(ip: string): string | null {
  return parseIp(ip)?.text ?? null;
}

/** 输入是否已是 canonical IP 文本（严格模式的可接受输入）。 */
export function isCanonicalIp(ip: string): boolean {
  const parsed = parseIp(ip);
  return parsed !== null && parsed.text === ip;
}

/** canonical CIDR 文本（网络地址/前缀）；非法返回 null。 */
export function canonicalCidr(cidr: string): string | null {
  return parseCidr(cidr)?.text ?? null;
}

/** IP 族别（IPv4-mapped 归一后为 v4）；非法返回 null。 */
export function ipFamily(ip: string): IpFamily | null {
  return parseIp(ip)?.family ?? null;
}

// ---------------------------------------------------------------------------
// 严格 API（非法/非规范配置直接抛错，failfast）

/** 严格解析 IP：必须已是 canonical 文本，或 IPv4-mapped 形式（归一为 v4）；否则抛错。 */
export function parseIpStrict(ip: string): ParsedIp {
  const parsed = parseIp(ip);
  if (parsed === null) {
    throw new Error("非法 IP 地址");
  }
  // “::ffff 映射归一 v4”是冻结规则：mapped 输入合法并归一为 v4；其余非 canonical 文本拒绝
  if (parsed.text !== ip && !(parsed.family === "v4" && ip.includes(":"))) {
    throw new Error("非规范的 IP 地址（必须是规范文本：v4 无前导零，v6 小写且按 RFC 5952 规范化）");
  }
  return parsed;
}

/**
 * 严格解析 CIDR：必须已是 canonical 文本，或 IPv4-mapped 形式（归一为 v4）且
 * 映射出的 v4 地址相对有效前缀主机位全零；否则抛错。
 * 一般 strict CIDR 一律要求 canonical 网络地址（network 位无主机位，如 10.1.0.0/8 拒绝）；
 * mapped 例外同样必须主机位为零：::ffff:1.2.3.0/120 合法（→ 1.2.3.0/24）、::ffff:1.2.3.4/120 拒绝。
 */
export function parseCidrStrict(cidr: string): ParsedCidr {
  const parsed = parseCidr(cidr);
  if (parsed === null) {
    throw new Error("非法 CIDR（必须是规范网络地址/前缀）");
  }
  const slash = cidr.indexOf("/");
  const ipPart = slash === -1 ? cidr : cidr.slice(0, slash);
  if (parsed.text !== cidr) {
    if (!ipPart.includes(":")) {
      throw new Error("非规范的 CIDR（必须是规范网络地址/前缀：无前导零、小写、主机位为零）");
    }
    // 唯一例外：IPv4-mapped 文本形式（归一为 v4 前缀），但映射出的 v4 地址相对有效前缀
    // 必须是网络地址（主机位全零）——mapped 精确 IP 合法归一，mapped CIDR 不允许主机位。
    const raw = parseIp(ipPart);
    const mask = maskBytes(parsed.prefix, V4_BYTE_COUNT);
    if (raw === null || raw.family !== "v4" || !bytesEqual(masked(raw.bytes, mask), raw.bytes)) {
      throw new Error("非规范的 CIDR（IPv4-mapped 形式必须是对应有效前缀的网络地址，主机位为零）");
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 匹配

/** 掩码比较：ip 落在 cidr（网络字节已掩码）内。 */
export function cidrContains(cidr: ParsedCidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;
  const mask = maskBytes(cidr.prefix, cidr.bytes.length);
  for (let i = 0; i < cidr.bytes.length; i++) {
    if (((ip.bytes[i] ?? 0) & (mask[i] ?? 0)) !== (cidr.bytes[i] ?? 0)) return false;
  }
  return true;
}

/** legacy 匹配（IPv4-only）：非法、IPv6、IPv4-mapped IPv6 输入一律 false。 */
export function isInCidr(ip: string, cidr: string): boolean {
  const parsed = legacyParseCidr(cidr);
  const ipNum = legacyIpToUint32(ip);
  if (parsed === null || ipNum === null) return false;
  // 前缀 0 时掩码为 0（移位会退化为 32 位取模，需单独处理）。
  const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((parsed.network & mask) >>> 0);
}

/** legacy 多网段匹配（IPv4-only）：命中任一即 true；非法网段忽略。 */
export function isInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => isInCidr(ip, cidr));
}

/** 严格匹配：任一参数非法/非规范即抛错。 */
export function isInCidrStrict(ip: string | ParsedIp, cidr: string | ParsedCidr): boolean {
  const parsedIp = typeof ip === "string" ? parseIpStrict(ip) : ip;
  const parsedCidr = typeof cidr === "string" ? parseCidrStrict(cidr) : cidr;
  return cidrContains(parsedCidr, parsedIp);
}

/** 严格多网段匹配：任一网段非法/非规范即抛错。 */
export function isInAnyCidrStrict(ip: string | ParsedIp, cidrs: readonly (string | ParsedCidr)[]): boolean {
  const parsedIp = typeof ip === "string" ? parseIpStrict(ip) : ip;
  return cidrs.some((cidr) => {
    const parsedCidr = typeof cidr === "string" ? parseCidrStrict(cidr) : cidr;
    return cidrContains(parsedCidr, parsedIp);
  });
}
