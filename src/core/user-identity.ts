// 用户身份识别（README §4.2）
// Token 校验通过后，身份取自来源 IP（内网）或 pi-agent-server 签发账号（公网）。
// NAT / 共享出口 / 伪造 IP 风险由网络边界控制，不在应用层解决。

export type IdentityContext = {
  sourceIp: string;
  isIntranet: boolean;
  accountId?: string; // 公网账号（来自签发 token）
};

export type UserIdentity =
  | { kind: "ip"; ip: string }
  | { kind: "account"; accountId: string };

export function resolveIdentity(ctx: IdentityContext): UserIdentity {
  if (ctx.isIntranet) {
    return { kind: "ip", ip: ctx.sourceIp };
  }
  if (!ctx.accountId) {
    throw new Error("公网请求必须携带签发账号（accountId）");
  }
  return { kind: "account", accountId: ctx.accountId };
}

// 生成稳定唯一键，用于会话归属比较（每个用户只能访问自己的会话）
export function identityKey(id: UserIdentity): string {
  return id.kind === "ip" ? `ip:${id.ip}` : `account:${id.accountId}`;
}
