// 外部插件宿主：在宿主完成存储与会话服务组装后执行阶段二注册。
// 插件为受信任的同进程代码，但只能通过此处提供的公开上下文声明路由和会话操作。

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { SessionService, type SessionDto } from "../application/session-service.js";
import {
  PLUGIN_ROUTE_ACCESS,
  PLUGIN_SESSION_TITLE_LIMITS,
  type LoadedPlugin,
  type PluginCapabilityTiers,
  type PluginHostContext,
  type PluginModeProfile,
  type PluginRoute,
  type PluginRouteAccess,
  type PluginSessionApi,
  type PluginSessionRef,
  type PluginTurnResult,
} from "../plugin/index.js";
import { identityKey } from "../core/user-identity.js";
import { TURN_TEXT_LIMITS, checkTurnText } from "../core/text-input.js";
import { TURN_ERROR_CODES } from "../application/ports/session-runtime-port.js";
import { allowsCapabilityTier, requirePermission, type RoutePermission } from "./route-rbac.js";

/**
 * 插件权限档位 → 中央权限点：**唯一映射表**。
 *
 * 用显式表而非 `route.access === "read" ? … : …` 三元：插件包是运行时 JS，
 * 非法 access 在三元下会静默拿到写权限（fail-open）；本表 + 注册期校验保证未知值 fail-closed。
 */
const PLUGIN_ROUTE_PERMISSIONS: Record<PluginRouteAccess, RoutePermission> = {
  read: "capability:read",
  write: "capability:write",
  admin: "capability:admin",
};

/** 能力投影的保留路径：插件不得声明同名路由（防止遮蔽宿主投影）。 */
const RESERVED_CAPABILITY_ACCESS_PATH = "/access";

/**
 * 是否已知的权限档位（运行时收口，拒绝 "readonly"/"wrtie" 之类变体）。
 * 用模块私有 Set 判定，不依赖可被同进程插件改写的导出数组。
 */
const PLUGIN_ROUTE_ACCESS_SET: ReadonlySet<string> = new Set<string>(PLUGIN_ROUTE_ACCESS);
function isPluginRouteAccess(value: unknown): value is PluginRouteAccess {
  return typeof value === "string" && PLUGIN_ROUTE_ACCESS_SET.has(value);
}

export type PluginHostOptions = {
  readonly app: FastifyInstance;
  readonly projectCwd: string;
  readonly sessions: SessionService;
};

/** 已注册插件的关闭控制器。 */
export type PluginHost = {
  dispose(): Promise<void>;
};

/**
 * 注册所有已校验插件。路由统一限定在 /v1/capabilities/<plugin-id>；
 * 同一插件任一路由注册或 register 失败均 fail-fast，由启动入口负责关闭已注册插件。
 */
export async function registerPlugins(
  plugins: readonly LoadedPlugin[],
  options: PluginHostOptions,
): Promise<PluginHost> {
  const registered: LoadedPlugin[] = [];
  try {
    for (const loaded of plugins) {
      const routes = new Set<string>();
      const declaredCapabilities = loaded.capabilities;
      // 能力映射在 register 期间由 declareCapabilities 填充；register 返回后校验完整性。
      let capabilityTiers: Readonly<Record<string, PluginRouteAccess>> | undefined;
      const context: PluginHostContext = {
        projectCwd: options.projectCwd,
        modes: loaded.modes,
        // 权威定义在 application/ports（经 public-api/contract 静态导出）；此处把同一对象
        // 注入插件，插件不重复定义这些字符串。冻结对象可直接共享，不存在被改写风险。
        turnErrorCodes: TURN_ERROR_CODES,
        declareCapabilities: (map) => {
          if (capabilityTiers !== undefined) {
            throw new Error(`插件重复声明能力映射: ${loaded.manifest.id}`);
          }
          capabilityTiers = validateCapabilityDeclarations(map, loaded.manifest.id, declaredCapabilities);
        },
        mountRoute: (route) => {
          const routeKey = `${route.method}:${route.path}`;
          if (routes.has(routeKey)) {
            throw new Error(`插件路由重复: ${loaded.manifest.id} -> ${routeKey}`);
          }
          assertRoute(route, loaded.manifest.id);
          routes.add(routeKey);
          registerRoute(options.app, loaded.manifest.id, route, options.sessions, loaded.modes);
        },
      };
      // register 可能在抛错前已分配资源；先登记，失败回滚时也必须调用其 dispose。
      registered.push(loaded);
      await loaded.plugin.register?.(context);
      // 声明过的每个 flag 必须有档位映射：否则它会在投影中静默恒 false（fail-closed，
      // 但那是“插件写错了”而不是“角色不允许”，必须在注册期暴露而不是线上才发现）。
      const unmapped = declaredCapabilities.filter(
        (flag) => capabilityTiers === undefined || !Object.hasOwn(capabilityTiers, flag),
      );
      if (unmapped.length > 0) {
        throw new Error(`插件能力缺少档位映射: ${loaded.manifest.id} -> ${unmapped.join(",")}`);
      }
      if (declaredCapabilities.length > 0) {
        registerCapabilityProjection(options.app, loaded.manifest.id, capabilityTiers ?? {});
      }
    }
  } catch (error) {
    try {
      await disposePlugins(registered);
    } catch (disposeError) {
      // 注册失败原因优先；清理异常仅作为 cause 的补充，不能掩盖启动根因。
      throw new Error("插件注册失败且清理失败", { cause: new AggregateError([error, disposeError]) });
    }
    throw error;
  }
  return { dispose: () => disposePlugins(registered) };
}

function createSessionApi(
  sessions: SessionService,
  modes: readonly PluginModeProfile[],
  ownerKey: string,
  requestSignal: AbortSignal | undefined,
): { api: PluginSessionApi; revoke(): void } {
  const profiles = new Map(modes.map((mode) => [mode.id, mode]));
  // 预约只在本请求上下文内有效：id -> modeId。请求结束对象即被回收，插件无法
  // 跨请求复用；create 只认本表，因此插件伪造/转手预约都会失败。
  const reservations = new Map<string, string>();
  // 本请求内所有在途 runTurn 的中止控制器：HTTP disconnect 或 handler 结束（revoke）
  // 都必须终止对应 task，保证脱离 client 的请求不会拖住撤销/优雅停机。
  const inFlightTurns = new Set<AbortController>();
  let active = true;
  const assertActive = (): void => {
    if (!active) throw new Error("会话 API 已失效");
  };
  const requireProfile = (modeId: string): PluginModeProfile => {
    const profile = profiles.get(modeId);
    if (!profile) throw new Error(`未知插件 mode: ${modeId}`);
    return profile;
  };
  return {
    api: {
      async reserve(input) {
        assertActive();
        const modeId = input?.modeId;
        if (typeof modeId !== "string" || modeId.trim() === "") {
          throw new Error("会话预约缺少 modeId");
        }
        requireProfile(modeId);
        const id = randomUUID();
        reservations.set(id, modeId);
        return { id, modeId };
      },
      async create(input) {
        assertActive();
        const reservation = input?.reservation;
        const id = reservation?.id;
        const modeId = reservation?.modeId;
        const pendingMode = typeof id === "string" ? reservations.get(id) : undefined;
        // 预约必须存在且与回传的 mode 一致；先消费，保证同一个预约绝不能被 create 两次。
        if (pendingMode === undefined || pendingMode !== modeId) {
          throw new Error("会话预约无效、已消费或不属于当前请求");
        }
        reservations.delete(id as string);
        const profile = requireProfile(pendingMode);
        // 提示词二选一（loader 已校验，此处用与宿主 createSession 相同的 fail-fast 防御）：
        // appendSystemPrompt → 宿主解析完整提示词后安全追加；systemPrompt → 旧的整体覆盖语义。
        const hasAppend = profile.appendSystemPrompt !== undefined;
        const hasOverride = profile.systemPrompt !== undefined;
        if (hasAppend === hasOverride) {
          throw new Error(`插件 mode 提示词无效（appendSystemPrompt/systemPrompt 须二选一）: ${profile.id}`);
        }
        const result = await sessions.createSession(ownerKey, {
          sessionId: id as string,
          ...(input.title !== undefined ? { title: input.title } : {}),
          modelProvider: profile.modelProvider,
          modelId: profile.modelId,
          ...(profile.thinkingLevel !== undefined ? { thinkingLevel: profile.thinkingLevel } : {}),
          ...(hasAppend
            ? { systemPromptAppend: profile.appendSystemPrompt as string }
            : { systemPromptOverride: profile.systemPrompt as string }),
        });
        if (result.kind === "id-conflict") {
          throw new Error(`会话预约 id 冲突: ${id as string}`);
        }
        if (result.kind !== "created") {
          throw new Error(`按 mode 创建会话失败: ${result.kind}`);
        }
        return sessionRef(result.session);
      },
      async restore(sessionId) {
        assertActive();
        const record = (await sessions.listSessions(ownerKey)).find((session) => session.id === sessionId);
        if (!record) return null;
        const entry = await sessions.getEntry(ownerKey, sessionId);
        return entry ? sessionRef(record) : null;
      },
      async getSystemPrompt(sessionId) {
        assertActive();
        // owner 固定为路由认证身份；SessionService 将越权/不存在统一折叠为 null，插件
        // 无法通过此 API 读取或探测其他 owner 的冻结提示词。
        return sessions.getSystemPrompt(ownerKey, sessionId);
      },
      async getMessages(sessionId) {
        assertActive();
        const id = requireTurnText(sessionId, "sessionId", 200);
        // exportSession 是既有的零 runtime 创建只读路径；这里只投影 messages，不将
        // timeline 或宿主 thinking 细节暴露给插件契约。
        const exported = await sessions.exportSession(ownerKey, id);
        return exported?.messages ?? null;
      },
      async setTitle(input) {
        assertActive();
        const sessionId = requireTurnText(input?.sessionId, "sessionId", 200);
        const title = requirePluginTitle(input?.title);
        if (input?.onlyIfEmpty !== undefined && typeof input.onlyIfEmpty !== "boolean") {
          throw new Error("插件会话标题 onlyIfEmpty 必须是布尔值");
        }
        const updated = input?.onlyIfEmpty === true
          ? await sessions.renameSession(ownerKey, sessionId, title, { onlyIfEmpty: true })
          : await sessions.renameSession(ownerKey, sessionId, title);
        // renameSession 统一折叠越权/不存在；插件不能用标题 API 探测其他 owner。
        return updated ? sessionRef(updated) : null;
      },
      supportsTurnCancellation: true,
      async runTurn(input): Promise<PluginTurnResult> {
        assertActive();
        const sessionId = requireTurnText(input?.sessionId, "sessionId", 200);
        const requestId = requireTurnText(
          input?.requestId,
          "requestId",
          TURN_TEXT_LIMITS.maxRequestIdLength,
        );
        const prompt = requireTurnText(input?.prompt, "prompt", TURN_TEXT_LIMITS.maxPromptLength);
        // 只传这三个字段：owner 由宿主绑定，模型/tools/cwd/图片不在签名中，插件无法指定。
        // per-turn AbortSignal：绑定本请求的 HTTP disconnect 与 API revoke；只终止本 task，
        // 不误杀其他 task（runtime 按 requestId 校验 currentKey 后再 abort）。
        const controller = new AbortController();
        const onRequestAbort = () => controller.abort();
        const signals = [requestSignal, input.signal].filter((signal): signal is AbortSignal => signal !== undefined);
        for (const signal of signals) {
          if (signal.aborted) controller.abort();
          else signal.addEventListener("abort", onRequestAbort, { once: true });
        }
        inFlightTurns.add(controller);
        try {
          const result = await sessions.runTurn(ownerKey, {
            sessionId,
            requestId,
            prompt,
            signal: controller.signal,
          });
          if (result === null) throw new Error("插件会话不存在或不属于当前 owner");
          return result;
        } finally {
          inFlightTurns.delete(controller);
          for (const signal of signals) signal.removeEventListener("abort", onRequestAbort);
        }
      },
    },
    revoke() {
      active = false;
      reservations.clear();
      // 先中止本请求内所有在途 runTurn，再让后续调用失效。
      for (const controller of [...inFlightTurns]) controller.abort();
      inFlightTurns.clear();
    },
  };
}

function sessionRef(session: SessionDto): PluginSessionRef {
  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * runTurn 的文本参数校验：非空字符串、不含非法控制字符、长度不超过宿主上限。
 * 与公开 `POST /v1/sessions/:id/messages` 共用 core/text-input.ts 的同一套规则（同一权威常量）。
 * 上限由宿主固定，插件无法覆盖。
 */
/** 标题是单行纯文本元数据，不复用 prompt 对 tab/newline 的兼容例外。 */
function requirePluginTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("插件会话标题必须是非空字符串");
  }
  const title = value.trim();
  if (title.length > PLUGIN_SESSION_TITLE_LIMITS.maxLength) {
    throw new Error("插件会话标题超过宿主上限");
  }
  if (/[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error("插件会话标题含非法控制字符");
  }
  return title;
}

function requireTurnText(value: unknown, label: string, maxLength: number): string {
  const result = checkTurnText(value, maxLength);
  if (!result.ok) {
    switch (result.reason) {
      case "empty":
        throw new Error(`插件 runTurn 的 ${label} 必须是非空字符串`);
      case "too-long":
        throw new Error(`插件 runTurn 的 ${label} 超过宿主上限`);
      case "control-characters":
        throw new Error(`插件 runTurn 的 ${label} 含非法控制字符`);
    }
  }
  return result.value;
}

const PLUGIN_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function assertRoute(route: PluginRoute, pluginId: string): void {
  if (!route.path.startsWith("/") || route.path.includes("..") || route.path.includes("//")) {
    throw new Error(`插件路由路径无效: ${pluginId} -> ${route.path}`);
  }
  // method 是运行时 JS 值（插件包不是 TypeScript），必须显式收口为规范大写集合。
  // 否则 "get" 之类变体会绕过下文的 HEAD opt-out，让 Fastify 派生出未声明的 HEAD 路由。
  if (typeof route.method !== "string" || !(PLUGIN_HTTP_METHODS as readonly string[]).includes(route.method)) {
    throw new Error(`插件路由方法无效: ${pluginId} -> ${route.path}`);
  }
  // access 同样是运行时 JS 值：未知档位必须 fail-closed，绝不静默降级为写权限。
  if (!isPluginRouteAccess(route.access)) {
    throw new Error(`插件路由 access 无效: ${pluginId} -> ${route.path} -> ${String(route.access)}`);
  }
  // `/access` 是宿主能力投影的保留路径；插件声明同名路由会遮蔽它，注册期直接拒绝。
  if (route.path === RESERVED_CAPABILITY_ACCESS_PATH) {
    throw new Error(`插件路由使用宿主保留路径: ${pluginId} -> ${route.path}`);
  }
  if (typeof route.handler !== "function") {
    throw new Error(`插件路由处理器无效: ${pluginId} -> ${route.path}`);
  }
}

/**
 * 校验插件声明的「业务 flag → 权限档位」映射。
 *
 * 插件是运行时 JS，因此 map 的形状、键与值都必须显式收口：
 * 键必须已在 manifest.capabilities 中声明（插件不能凭空发明宿主未审计的标识），
 * 值必须是已知档位（read/write/admin）。
 */
function validateCapabilityDeclarations(
  map: unknown,
  pluginId: string,
  declared: readonly string[],
): Readonly<Record<string, PluginRouteAccess>> {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw new Error(`插件能力映射无效: ${pluginId}`);
  }
  const declaredSet = new Set(declared);
  const tiers: Record<string, PluginRouteAccess> = {};
  for (const [flag, tier] of Object.entries(map as Record<string, unknown>)) {
    if (!declaredSet.has(flag)) {
      throw new Error(`插件能力映射含未声明的标识: ${pluginId} -> ${flag}`);
    }
    if (!isPluginRouteAccess(tier)) {
      throw new Error(`插件能力档位无效: ${pluginId} -> ${flag} -> ${String(tier)}`);
    }
    tiers[flag] = tier;
  }
  return tiers;
}

/**
 * 挂载插件能力投影：`GET /v1/capabilities/<plugin-id>/access`。
 *
 * 响应体恰好是 manifest 声明的 flag 集合（不多不少），值为布尔；由中央矩阵经
 * allowsCapabilityTier 派生，role 缺失/未知一律 false（fail-closed）。
 * 宿主不解释 flag 语义——「canBind 意味着什么」是插件自己的事。
 */
function registerCapabilityProjection(
  app: FastifyInstance,
  pluginId: string,
  tiers: Readonly<Record<string, PluginRouteAccess>>,
): void {
  const flags = Object.keys(tiers);
  app.route({
    method: "GET",
    url: `/v1/capabilities/${pluginId}${RESERVED_CAPABILITY_ACCESS_PATH}`,
    // 与插件路由一致：宿主显式禁用 GET 派生的自动 HEAD 路由。
    exposeHeadRoute: false,
    ...requirePermission("capability:read"),
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const access = request.access as { role?: unknown } | undefined;
      const role = access === undefined ? undefined : access.role;
      const projection: Record<string, boolean> = {};
      for (const flag of flags) {
        projection[flag] = allowsCapabilityTier(tiers[flag], role);
      }
      // 响应体依赖调用方身份（当前仅来自来源 IP，无 Bearer token）：
      // 绝不能被共享代理/浏览器中间缓存，否则 admin 的 {canBind:true} 会回给其他来源。
      // 仅靠 Vary: Authorization 不够——身份可能只由 IP 决定。
      reply.header("cache-control", "private, no-store");
      return projection;
    },
  });
}

/** 把本次请求的权限档位投影成三个布尔；role 缺失/未知一律 false（fail-closed）。 */
function capabilityTiersOf(request: FastifyRequest): PluginCapabilityTiers {
  const access = request.access as { role?: unknown } | undefined;
  const role = access === undefined ? undefined : access.role;
  return {
    read: allowsCapabilityTier("read", role),
    write: allowsCapabilityTier("write", role),
    admin: allowsCapabilityTier("admin", role),
  };
}

/** 兼容测试/非 HTTP 组合的最小事件源形状（仅用 on/off/writableEnded）。 */
type NodeLikeEmitter = {
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
  writableEnded?: boolean;
};

/**
 * 把 HTTP 连接断开绑定为 AbortSignal。以响应对象（ServerResponse）的 close 为准：
 * 正常完成时 close 也会触发（writableEnded=true），只有响应未写完才视为客户端断开。
 * 监听器只在插件 handler 执行期生效（handler 返回后 dispose 移除），因此正常响应
 * 完成不会误触发。无 raw 流（单测 mock）时返回不会自动 abort 的 signal。
 */
function bindHttpDisconnect(
  request: FastifyRequest,
  reply: FastifyReply,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const responseRaw = reply.raw as unknown as NodeLikeEmitter | undefined;
  const requestRaw = request.raw as unknown as NodeLikeEmitter | undefined;
  const emitter =
    responseRaw && typeof responseRaw.on === "function"
      ? responseRaw
      : requestRaw && typeof requestRaw.on === "function"
        ? requestRaw
        : undefined;
  const on = emitter?.on;
  if (emitter === undefined || typeof on !== "function") {
    return { signal: controller.signal, dispose: () => {} };
  }
  const onClose = () => {
    // ServerResponse 正常完成也会触发 close；此时 writableEnded 为 true，不视为断开。
    if (responseRaw?.writableEnded !== true) controller.abort();
  };
  on.call(emitter, "close", onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      emitter.off?.("close", onClose);
    },
  };
}

function registerRoute(
  app: FastifyInstance,
  pluginId: string,
  route: PluginRoute,
  sessions: SessionService,
  modes: readonly PluginModeProfile[],
): void {
  const permission = PLUGIN_ROUTE_PERMISSIONS[route.access];
  app.route({
    method: route.method,
    url: `/v1/capabilities/${pluginId}${route.path}`,
    // 插件只能暴露契约显式声明的方法：GET 默认会被 Fastify 派生一条自动 HEAD 路由执行同一
    // handler，插件从未声明 HEAD，宿主显式禁用。HEAD 因此 404（未匹配真实路由，不进 RBAC/
    // handler/session API）。非 GET 方法不受该选项影响。
    ...(route.method === "GET" ? { exposeHeadRoute: false } : {}),
    ...requirePermission(permission),
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const ownerKey = identityKey(request.user);
      // 每个 HTTP 请求绑定一个 disconnect signal，并把它交给 session API 作为 per-turn
      // AbortSignal；handler 返回（revoke）时再兜底中止未结束的在途 turn。
      const disconnect = bindHttpDisconnect(request, reply);
      const sessionScope = createSessionApi(sessions, modes, ownerKey, disconnect.signal);
      try {
        return await route.handler({
          ownerKey,
          sessions: sessionScope.api,
          capabilities: capabilityTiersOf(request),
          request,
          reply,
        });
      } catch {
        // 插件内部异常不得把数据库、路径或第三方服务细节序列化给调用方。
        return reply.code(500).send({ statusCode: 500, error: "Internal Server Error", message: "插件请求失败" });
      } finally {
        sessionScope.revoke();
        disconnect.dispose();
      }
    },
  });
}

async function disposePlugins(plugins: readonly LoadedPlugin[]): Promise<void> {
  const errors: unknown[] = [];
  for (const loaded of [...plugins].reverse()) {
    try {
      await loaded.plugin.dispose?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "插件 dispose 失败");
}
