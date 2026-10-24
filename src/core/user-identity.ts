// 用户身份（docs/ip-rbac-design.md、docs/login-design.md §2）。身份怎么来取决于 PI_AUTH_MODE：
// - ip（默认，冻结）：身份 = canonical 来源 IP（默认直接 socket IP；仅当 TCP 对端为回环（同机反向代理）
//   时改用 X-Forwarded-For 最右条目；IPv4-mapped 归一为 v4），一个 IP = 一个用户；token 只满足
//   tokenRequired，不改变身份、不能绕过 CIDR。
// - accounts：身份 = 登录的账号（cookie 或个人 token），IP 只做准入。
// 业务代码只用 identityKey 得到的不透明 owner key，不区分模式。

export type UserIdentity =
  | { kind: "ip"; ip: string }
  | { kind: "account"; accountId: string };

// 生成稳定唯一键，用于会话归属比较（每个用户只能访问自己的会话）
export function identityKey(id: UserIdentity): string {
  return id.kind === "account" ? `user:${id.accountId}` : `ip:${id.ip}`;
}
