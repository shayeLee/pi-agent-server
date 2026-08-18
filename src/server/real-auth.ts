// 真实鉴权（needs.md §4.2 鉴权与用户标识）
// 内网免 token：来源 IP 命中内网网段即按 IP 识别（接入鉴权由网络边界保证，伪造 IP 风险不在应用层解决）。
// 公网需 Bearer Token：token → accountId 映射来自配置（模拟 pi-agent-server 签发账号）。
// 复用 resolveIdentity，不重写身份判定逻辑。

import type { FastifyRequest } from "fastify";
import type { UserIdentity } from "../core/user-identity.js";
import { resolveIdentity } from "../core/user-identity.js";
import { isInAnyCidr } from "../core/cidr.js";
import type { Authenticate } from "./auth.js";

export type AuthConfig = {
  /** 内网判定网段表（如 ["10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12"]） */
  intranetCidrs: string[];
  /** token → accountId 映射（pi-agent-server 签发账号，仅公网使用） */
  tokens: Record<string, string>;
};

/** 真实鉴权工厂：内网 IP 免 token 识别；公网 Bearer Token 校验 + 账号身份判定。 */
export function buildAuthenticate(config: AuthConfig): Authenticate {
  return async (request: FastifyRequest): Promise<UserIdentity> => {
    const sourceIp = request.ip;
    const isIntranet = isInAnyCidr(sourceIp, config.intranetCidrs);

    // 内网免 token：命中内网网段直接按 IP 识别（不校验 Bearer Token）
    if (isIntranet) {
      return resolveIdentity({ sourceIp, isIntranet: true });
    }

    // 公网：校验 Bearer Token（scheme 大小写不敏感，RFC 7235），按签发账号识别
    const header = request.headers.authorization;
    const match = /^Bearer[ \t]+(\S+)$/i.exec(header ?? "");
    if (!match) {
      throw new Error("缺少 Bearer Token");
    }
    const token = match[1]!;
    // 仅接受 tokens 的自有属性：避免 token 命中 Object.prototype（toString/constructor/__proto__ 等）造成鉴权绕过。
    const accountId = Object.hasOwn(config.tokens, token) ? config.tokens[token] : undefined;
    if (!accountId) {
      throw new Error("未知 Token");
    }
    return resolveIdentity({ sourceIp, isIntranet: false, accountId });
  };
}