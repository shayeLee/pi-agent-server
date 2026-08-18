// trustProxy 安全策略：内网免 token 依赖来源 IP 判定，
// 全信任 trustProxy 会信任任意 X-Forwarded-For，公网可伪造内网 IP 绕过鉴权。
//
// 因此内网免 token 时只允许「具体 IP 白名单」：拒绝 true、数字跳数、函数、
// 网段别名（loopback/linklocal/uniquelocal 等）与一切 CIDR。
// 拒绝 CIDR 是刻意的：仅黑名单单个全地址网段（0.0.0.0/0、::/0）无法阻止
// ["0.0.0.0/1","128.0.0.0/1"] / ["::/1","8000::/1"] 这类组合全量覆盖；
// 代理信任列表本就应是少量具体 IP，禁用 CIDR 是最小且足够安全的边界。
// 参数用 unknown：类型系统不作为安全边界，运行时须防御 JS/类型断言传入的任意值。

import { isIP } from "node:net";

/** 校验 trustProxy 与内网免 token 的组合；非法组合抛错（启动时校验）。 */
export function validateTrustProxyConfig(trustProxy: unknown, intranetCidrs: string[]): void {
  if (intranetCidrs.length === 0) return; // 无内网免 token，无伪造风险
  if (Array.isArray(trustProxy)) {
    // Fastify 语义：数组元素不按逗号拆分，必须各自是具体 IP
    for (const item of trustProxy) validateProxyEntry(item, false);
  } else {
    // 顶层字符串按逗号拆分（Fastify 语义）
    validateProxyEntry(trustProxy, true);
  }
}

function validateProxyEntry(raw: unknown, splitComma: boolean): void {
  if (raw === true) {
    throw new Error(
      "内网免 token 时禁止全信任 trustProxy（true，公网可伪造 X-Forwarded-For 绕过鉴权）；请改用具体的代理 IP 白名单",
    );
  }
  if (raw === false || raw === undefined || raw === null) return; // 不信任代理
  if (typeof raw === "number") {
    throw new Error(
      "内网免 token 时禁止 trustProxy 数字跳数（信任任意 hop，公网可伪造 X-Forwarded-For 绕过鉴权）；请改用具体的代理 IP 白名单",
    );
  }
  if (typeof raw !== "string") {
    throw new Error(
      "内网免 token 时 trustProxy 只允许具体的代理 IP 白名单（字符串或字符串数组），不接受函数/其他类型",
    );
  }
  const tokens = splitComma ? raw.split(",") : [raw];
  for (const token of tokens) {
    const trimmed = token.trim();
    // 只接受具体 IP 字面量：空 token、CIDR（含 /）、网段别名与非 IP 值一律拒绝
    if (trimmed === "" || trimmed.includes("/") || isIP(trimmed) === 0) {
      throw new Error(
        "内网免 token 时 trustProxy 只允许具体的代理 IP 地址（如 127.0.0.1 或 ::1），禁止 CIDR 网段、网段别名、空条目与非 IP 值（公网可伪造 X-Forwarded-For 绕过鉴权）",
      );
    }
  }
}
