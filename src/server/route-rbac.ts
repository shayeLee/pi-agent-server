// WP5D-3 路由授权（role → permission 矩阵；docs/ip-rbac-design.md §6 冻结矩阵）
//
// 冻结矩阵（每路由显式声明 permission，未声明 → default-deny 403）：
// - /health、/readyz：任意 admitted role；
// - /metrics：仅 admin/operator；
// - /v1：viewer 允许纯读 GET（models/projects/sessions 列表、session export、SSE events、
//   access 能力投影），拒绝全部 POST/PATCH/DELETE（含 messages/steer/follow-up/abort）与其余 /v1 路由；
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
import { PLUGIN_ROUTE_ACCESS, type PluginRouteAccess } from "../plugin/contract.js";

/**
 * 插件权限档位 → 允许角色集合：插件能力档位的**唯一权威词汇表**。
 *
 * 档位是宿主词汇（少而稳定），插件的业务 flag 是插件词汇（可自由增殖）：
 * 插件只声明「flag → 档位」，宿主不解释 flag 语义，路由 gate 与能力投影都从本表派生，
 * 因此新增一个插件 flag 不需要改动宿主。档位集合由 PLUGIN_ROUTE_ACCESS 冻结为三个值，
 * 不会随插件 flag 增长——档位一多，统一授权矩阵就退化成插件私有 ACL。
 *
 * 深冻结：授权表与内部角色数组都不可变。同进程插件属于受信代码但仍不应具备改写
 * 授权表的能力（否则 `CAPABILITY_TIER_ROLES.admin.push("user")` 会同时改变路由 gate
 * 与能力投影），因此这里不依赖「插件不会这么做」的约定。
 */
export const CAPABILITY_TIER_ROLES: Record<PluginRouteAccess, readonly IpRole[]> = Object.freeze({
  read: Object.freeze(["admin", "user", "viewer"] as IpRole[]),
  write: Object.freeze(["admin", "user"] as IpRole[]),
  admin: Object.freeze(["admin"] as IpRole[]),
});

/** 已知角色集合（策略解析器已保证 policy 内 role 合法；此处防御未知/伪造值）。 */
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(IP_ROLES);

/** 构造不可变的角色集合（授权表运行时不可被同进程插件改写）。 */
function frozenRoles(...roles: IpRole[]): readonly IpRole[] {
  return Object.freeze(roles);
}

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
  | "sessions:file-preview"
  | "sessions:events"
  | "capability:read"
  | "capability:write"
  | "capability:admin"
  | "access:read";

/** 中央权限定义：permission → 允许角色集合（default-deny：不在集合内 → 403）。 */
export const ROUTE_PERMISSIONS: Record<RoutePermission, readonly IpRole[]> = Object.freeze({
  // 探针：health/readyz 任何 admitted role；metrics 仅 admin/operator。
  "probe:health": frozenRoles("admin", "user", "viewer", "operator"),
  "probe:readyz": frozenRoles("admin", "user", "viewer", "operator"),
  "probe:metrics": frozenRoles("admin", "operator"),
  // viewer 纯读：模型/项目/会话列表、会话导出、SSE 事件流。
  "models:list": frozenRoles("admin", "user", "viewer"),
  "projects:list": frozenRoles("admin", "user", "viewer"),
  "sessions:list": frozenRoles("admin", "user", "viewer"),
  "sessions:export": frozenRoles("admin", "user", "viewer"),
  "sessions:file-preview": frozenRoles("admin", "user", "viewer"),
  "sessions:events": frozenRoles("admin", "user", "viewer"),
  // 外部能力插件：三个档位由 CAPABILITY_TIER_ROLES 单一权威派生（不重复字面量，杜绝漂移）。
  // read：查询允许 viewer/user/admin；write：常规变更允许 user/admin；admin：管理级变更仅 admin。
  "capability:read": CAPABILITY_TIER_ROLES.read,
  "capability:write": CAPABILITY_TIER_ROLES.write,
  "capability:admin": CAPABILITY_TIER_ROLES.admin,
  // P7b 宿主访问能力投影端点：与其它纯读 GET 同为 viewer/user/admin；operator 仍拒。
  "access:read": frozenRoles("admin", "user", "viewer"),
  // 写/变更：user/admin（仍 owner 隔离；admin 暂不跨 owner）。
  "projects:create": frozenRoles("admin", "user"),
  "projects:delete": frozenRoles("admin", "user"),
  "sessions:create": frozenRoles("admin", "user"),
  "sessions:delete": frozenRoles("admin", "user"),
  "sessions:update": frozenRoles("admin", "user"),
  "sessions:update-config": frozenRoles("admin", "user"),
  "sessions:send-message": frozenRoles("admin", "user"),
  "sessions:control": frozenRoles("admin", "user"), // steer / follow-up / abort
});

/**
 * P7b 宿主访问能力投影（`GET /v1/access` 的最小固定响应体）：`{canRead, canWrite}`。
 *
 * 只返回布尔值，绝不携带 role/IP/token；由中央矩阵 `ROUTE_PERMISSIONS` +
 * `evaluateRouteAuthorization` 派生，端点与授权矩阵不会漂移。
 *
 * - `canRead`：读类权限（会话列表/导出/事件流 + 能力查询）是否**全部**对 role 开放
 *   （当前 viewer/user/admin）；
 * - `canWrite`：写/控制类权限（`sessions:send-message`、`sessions:control`、
 *   `capability:write`）是否**全部**对 role 开放（当前 user/admin）。
 *
 * 采用「全部允许」的交集语义：当前矩阵中这三项与读写两极完全一致；未来若矩阵出现分项
 * 不一致，布尔值只会更保守（少报可写），前端可据此隐藏写操作，绝不误放行。
 */
export type AccessCapabilities = { readonly canRead: boolean; readonly canWrite: boolean };

const READ_CAPABILITY_PERMISSIONS: readonly RoutePermission[] = [
  "sessions:list",
  "sessions:export",
  "sessions:file-preview",
  "sessions:events",
  "capability:read",
];

const WRITE_CAPABILITY_PERMISSIONS: readonly RoutePermission[] = [
  "sessions:send-message",
  "sessions:control",
  "capability:write",
];

/** 从中央矩阵推导访问能力投影；role 缺失/未知/伪造 → 两项均为 false（failclosed）。 */
export function projectAccessCapabilities(role: unknown): AccessCapabilities {
  const allows = (permission: RoutePermission): boolean =>
    evaluateRouteAuthorization(permission, role).verdict === "allowed";
  return {
    canRead: READ_CAPABILITY_PERMISSIONS.every(allows),
    canWrite: WRITE_CAPABILITY_PERMISSIONS.every(allows),
  };
}

export function isRoutePermission(value: unknown): value is RoutePermission {
  return typeof value === "string" && Object.hasOwn(ROUTE_PERMISSIONS, value);
}

/**
 * 单个插件能力档位对某 role 是否允许（插件能力投影的唯一判定入口）。
 *
 * fail-closed：未知档位、缺失/未知/伪造 role 一律 false，绝不因名义而误报可写。
 * 直接读 CAPABILITY_TIER_ROLES（而非拼 permission 字符串），因此与路由 gate 同源、不会漂移。
 */
export function allowsCapabilityTier(tier: unknown, role: unknown): boolean {
  if (typeof tier !== "string" || !Object.hasOwn(CAPABILITY_TIER_ROLES, tier)) return false;
  if (typeof role !== "string" || !KNOWN_ROLES.has(role)) return false;
  return CAPABILITY_TIER_ROLES[tier as PluginRouteAccess].includes(role as IpRole);
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