// WP5D-3 路由授权（role → permission 矩阵；docs/ip-rbac-design.md §6 冻结矩阵）
//
// 冻结矩阵（每路由显式声明 permission，未声明 → default-deny 403）：
// - /health、/readyz：任意 admitted role；
// - /metrics：仅 admin/operator；
// - /v1：viewer 允许纯读 GET（models/projects/sessions 列表、session export、SSE events），
//   拒绝全部 POST/PATCH/DELETE（含 messages/steer/follow-up/abort）与其余 /v1 路由；
// - operator：/v1 全部拒绝（403）；user/admin：现有 own-resource 行为（仍 owner 隔离，
//   admin 暂不跨 owner）。
//
// 语义：
// - 授权只依据 request.access（admission 注入的 public profile）的 role；缺失/未知/伪造 role
//   → failclosed deny（unknown/forged access 一律 403）；
// - 403 固定响应体（FORBIDDEN_BODY），不泄 role/IP/path；拒绝日志只带固定枚举（subjectHash
//   由 admission 后置日志携带，不记录原始 IP；cwd/Agent 工具绝对路径不在 IP-RBAC 范围内）；
// - CORS 预检不做 role/token：@fastify/cors 的 onRequest（注册于本 hook 之前）对预检直接回
//   204，本 hook 从不执行于预检请求；实际请求才 role gate；
// - 路由 config.permission 是唯一声明点：新增路由忘接线 → 全局 hook default-deny 403，
//   绝不因 method 粗略匹配误放行。

import type { FastifyReply, FastifyRequest } from "fastify";
import { IP_ROLES, type IpRole } from "../core/ip-access-policy.js";

/** 已知角色集合（策略解析器已保证 policy 内 role 合法；此处防御未知/伪造值）。 */
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(IP_ROLES);

/**
 * 每路由显式声明的权限点（与 ROUTE_PERMISSIONS 一一对应）。
 * 命名按资源 + 动作，不按 method，避免「method 近似」误放行。
 */
export type RoutePermission =
  | "probe:health"
  | "probe:readyz"
  | "probe:metrics"
  | "models:list"
  | "projects:list"
  | "projects:create"
  | "projects:delete"
  | "sessions:list"
  | "sessions:create"
  | "sessions:delete"
  | "sessions:update"
  | "sessions:update-config"
  | "sessions:send-message"
  | "sessions:control"
  | "sessions:export"
  | "sessions:events";

/** 中央权限定义：permission → 允许角色集合（default-deny：不在集合内 → 403）。 */
export const ROUTE_PERMISSIONS: Record<RoutePermission, readonly IpRole[]> = {
  // 探针：health/readyz 任何 admitted role；metrics 仅 admin/operator。
  "probe:health": ["admin", "user", "viewer", "operator"],
  "probe:readyz": ["admin", "user", "viewer", "operator"],
  "probe:metrics": ["admin", "operator"],
  // viewer 纯读：模型/项目/会话列表、会话导出、SSE 事件流。
  "models:list": ["admin", "user", "viewer"],
  "projects:list": ["admin", "user", "viewer"],
  "sessions:list": ["admin", "user", "viewer"],
  "sessions:export": ["admin", "user", "viewer"],
  "sessions:events": ["admin", "user", "viewer"],
  // 写/变更：user/admin（仍 owner 隔离；admin 暂不跨 owner）。
  "projects:create": ["admin", "user"],
  "projects:delete": ["admin", "user"],
  "sessions:create": ["admin", "user"],
  "sessions:delete": ["admin", "user"],
  "sessions:update": ["admin", "user"],
  "sessions:update-config": ["admin", "user"],
  "sessions:send-message": ["admin", "user"],
  "sessions:control": ["admin", "user"], // steer / follow-up / abort
};

export function isRoutePermission(value: unknown): value is RoutePermission {
  return typeof value === "string" && Object.hasOwn(ROUTE_PERMISSIONS, value);
}

export type RouteAuthorizationVerdict =
  | { verdict: "allowed" }
  | { verdict: "denied"; reason: "undeclared" | "role-forbidden" };

/**
 * 纯决策函数（default-deny）：
 * - permission 未声明/未知 → denied(undeclared)；
 * - role 缺失/未知/伪造 → denied(role-forbidden)（failclosed）；
 * - 已知 permission + 已知 role 但不在允许集合 → denied(role-forbidden)。
 */
export function evaluateRouteAuthorization(permission: unknown, role: unknown): RouteAuthorizationVerdict {
  if (!isRoutePermission(permission)) return { verdict: "denied", reason: "undeclared" };
  if (typeof role !== "string" || !KNOWN_ROLES.has(role)) {
    return { verdict: "denied", reason: "role-forbidden" };
  }
  if (!ROUTE_PERMISSIONS[permission].includes(role as IpRole)) {
    return { verdict: "denied", reason: "role-forbidden" };
  }
  return { verdict: "allowed" };
}

/**
 * 固定 403 响应体：与准入拒绝同一字面量（statusCode/error/message），
 * 绝不携带 role/IP/path/内部细节。
 */
export const FORBIDDEN_BODY = { statusCode: 403, error: "Forbidden", message: "请求被拒绝" } as const;

/**
 * 路由级显式 permission 声明（配合全局 default-deny hook 的唯一声明点）：
 * 每路由注册必须显式接线；漏接（无 config.permission）→ 403，不会静默放行。
 */
export function requirePermission(permission: RoutePermission): { config: { permission: RoutePermission } } {
  return { config: { permission } };
}

/**
 * 全局角色 gate（onRequest；注册顺序：admission → @fastify/cors → 本 hook）。
 * - 预检 OPTIONS 由 CORS 先行直接回 204，本 hook 不执行（预检不做 role/token）；
 * - 实际请求：default-deny + 每路由显式 permission；role 缺失/未知 failclosed 403；
 * - 拒绝不产生任何 service 调用（零副作用），日志只带固定枚举。
 */
export async function routeRbacOnRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Fastify 404 回退上下文（未匹配真实路由：未知路径/未注册方法/route-level 禁用的 HEAD）没有
  // config.url；此类请求交回 404 逻辑（维持既有 404 语义：未知路径与跨 owner 404 一致，不细分）。
  // 只有真实注册的路由才做 role gate；真实路由漏接 permission → 下方 default-deny 403。
  const routeConfig = request.routeOptions.config as { url?: unknown; permission?: unknown };
  if (routeConfig.url === undefined) return;
  const access = request.access as { role?: unknown } | undefined;
  const verdict = evaluateRouteAuthorization(
    routeConfig.permission,
    access === undefined ? undefined : access.role,
  );
  if (verdict.verdict === "allowed") return;
  // 日志只带固定枚举（authz 字段名避开 pino redact 的 authorization/token 路径；
  // subjectHash 由 admission 后置日志携带，不记录原始 IP/role 值）。
  request.log.info({ authz: "denied", reason: verdict.reason }, "request denied by route authorization");
  return reply.code(403).send(FORBIDDEN_BODY);
}

// 路由 config 的权限字段类型（FastifyContextConfig 可合并）：request.routeOptions.config.permission。
declare module "fastify" {
  interface FastifyContextConfig {
    /** WP5D-3：每路由显式声明的权限点（ROUTE_PERMISSIONS 的键）；缺失 → default-deny 403。 */
    permission?: RoutePermission;
  }
}