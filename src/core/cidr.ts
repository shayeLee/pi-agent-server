// IPv4 CIDR 匹配（needs.md §4.2 内网判定）
// 用无符号 32 位整数实现；对非法 IP/CIDR 返回 false 而不是抛错。

// 解析 IPv4 点分十进制为无符号 32 位整数；非法返回 null
function ipToUint32(ip: string): number | null {
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

// 解析 "网络地址/前缀"；非法返回 null
function parseCidr(cidr: string): { network: number; prefix: number } | null {
  const slash = cidr.indexOf("/");
  if (slash === -1) return null;
  const ipPart = cidr.slice(0, slash);
  const prefixPart = cidr.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix > 32) return null;
  const network = ipToUint32(ipPart);
  if (network === null) return null;
  return { network, prefix };
}

/** 判断 ip 是否落在 cidr 网段内；非法输入一律返回 false。 */
export function isInCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  const ipNum = ipToUint32(ip);
  if (parsed === null || ipNum === null) return false;
  // 前缀 0 时掩码为 0（移位会退化为 32 位取模，需单独处理）
  const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((parsed.network & mask) >>> 0);
}

/** 判断 ip 是否命中网段表任意一个；空表或全不命中返回 false。 */
export function isInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => isInCidr(ip, cidr));
}