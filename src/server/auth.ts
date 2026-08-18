// 鉴权接口（README §4.2 / docs/architecture.md 数据流 ①②）
// 职责：校验 Bearer Token 通过后，从请求提取 UserIdentity——
// 内网请求按来源 IP 识别，公网请求按 pi-agent-server 签发账号识别。
// 本步只固定接口签名与依赖注入边界（buildApp 注入 authenticate 桩）；
// 真实 Token 校验与内网/公网判定的实现不在本步，由后续步骤替换占位实现。
// 路由侧通过 request.user（onRequest hook 注入）读取身份，不感知实现细节。

import type { FastifyRequest } from "fastify";
import type { UserIdentity } from "../core/user-identity.js";

export type Authenticate = (request: FastifyRequest) => Promise<UserIdentity>;

/**
 * 占位实现：真实 Token 校验 + 内网 IP / 公网账号身份判定在后续步骤接入。
 * 当前未注入时直接抛错，避免路由在无鉴权边界下静默放行。
 */
export async function authenticate(_request: FastifyRequest): Promise<UserIdentity> {
  throw new Error("authenticate 未接入：真实 Token 校验与内网/公网身份判定在后续步骤实现");
}

// 请求级身份挂载点：onRequest hook 鉴权通过后写入，路由读取 request.user；subjectHash 用于日志关联
declare module "fastify" {
  interface FastifyRequest {
    user: UserIdentity;
    subjectHash: string;
  }
}