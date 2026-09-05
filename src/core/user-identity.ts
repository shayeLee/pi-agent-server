// 用户身份（needs.md §4.2 / docs/ip-rbac-design.md §2）
// WP5D-2 接线后：身份 = canonical 来源 IP（直接 socket IP，IPv4-mapped 归一为 v4），
// 一个 IP = 一个用户；token 只满足 tokenRequired，不改变身份、不能绕过 CIDR。

export type UserIdentity = { kind: "ip"; ip: string };

// 生成稳定唯一键，用于会话归属比较（每个用户只能访问自己的会话）
export function identityKey(id: UserIdentity): string {
  return `ip:${id.ip}`;
}