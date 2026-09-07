// HTTP composition root: Fastify concerns (authentication, validation, response mapping, SSE, CORS and shutdown)
// remain here; session/project application behavior is implemented by SessionService.

import { randomUUID, createHash } from "node:crypto";
import type { Writable } from "node:stream";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import { identityKey, type UserIdentity } from "../core/user-identity.js";
import type { IpAccessResolveInput } from "../core/ip-access-policy.js";
import { ConcurrencyController } from "../core/concurrency-control.js";
import type { AgentAdapter } from "../agent/agent-adapter.js";
import type {
  IdempotencyStorePort,
  ModelCatalogPort,
  ModelDescriptor,
  ObservabilityPort,
  ProjectStorePort,
  SessionHistoryReader,
  SessionStorePort,
  SystemPromptPort,
} from "../application/ports/index.js";
import { RuntimeRegistry, SessionDeletedError, type SessionEntry } from "../runtime/runtime-registry.js";
import { SessionService, THINKING_LEVELS } from "../application/session-service.js";
import {
  createAdmission,
  requireIpAccessRuntimeConfig,
  type AdmissionResult,
} from "./network-admission.js";
import {
  createOperationStatus,
  readyzBody,
  renderMetrics,
  type OperationStatus,
} from "./ops-status.js";
import {
  FORBIDDEN_BODY,
  requirePermission,
  routeRbacOnRequest,
} from "./route-rbac.js";
import { formatSseEvent } from "./sse-format.js";
import { nextBackpressureState, SSE_BACKPRESSURE_THRESHOLD } from "./sse-backpressure.js";
import { defaultSseSocket, type SseReplyRaw, type SseRequestRaw, type SseSocket } from "./sse-socket.js";

export type ServerDeps = {
  sessions: SessionStorePort;
  /**
   * WP5D-2 网络准入配置（严格必填，无默认）：app 全局 onRequest admission 唯一数据源。
   * 运行时做严格 shape 校验（requireIpAccessRuntimeConfig）：缺失/伪造/字段非法一律 failfast——
   * 直接 JS bypass 同样被拒。
   */
  ipAccess: IpAccessResolveInput;
  projects: ProjectStorePort;
  defaultProjectCwd: string;
  defaultProjectName?: string;
  modelCatalog?: ModelCatalogPort;
  defaultModel?: ModelDescriptor | null;
  defaultThinkingLevel?: string;
  createAdapter: (sessionId: string) => Promise<AgentAdapter>;
  /**
   * 只读会话历史解析口（WP5D-3 P1，生产组合 root 注入）：GET export 对「已持久化但
   * 未实例化」的会话做零写只读导出；缺省只在测试/非生产组合缺失，命中即 failclosed。
   */
  sessionHistoryReader?: SessionHistoryReader;
  /**
   * 可注入的 RuntimeRegistry（默认内部创建）：测试注入共享 registry 以便预置 runtime
   * 验证 SSE viewer 已有 runtime 的订阅路径；生产组合不传。
   */
  registry?: RuntimeRegistry;
  concurrency?: ConcurrencyController;
  idempotencyRepo?: IdempotencyStorePort;
  /** 观测订阅口（可选；关键路径推送脱敏观测事件）。 */
  observability?: ObservabilityPort;
  /**
   * 测试/自定义注入（生产不传，缺省 stdout）：Fastify 内置 pino 的目的流。
   * 测试用内存 Writable 捕获真实序列化出来的日志行，断言请求日志脱敏
   * （allowed/401/403 三类结果都不含 raw IP/url/token）。
   */
  requestLogStream?: Writable;
  /** SSE 每用户连接上限（默认 10）。 */
  maxSsePerUser?: number;
  /** SSE 全局连接上限（默认 100）。 */
  maxSseGlobal?: number;
  /** SSE 背压连续写失败阈值（默认 200）。 */
  sseBackpressureThreshold?: number;
  /** SSE 底层 socket 工厂（测试注入 fake socket 验证背压/断线清理；默认包装 reply.raw/request.raw）。 */
  sseSocketFactory?: (replyRaw: SseReplyRaw, requestRaw: SseRequestRaw) => SseSocket;
  serverEpoch?: string;
  systemPrompt?: string;
  systemPromptResolver?: SystemPromptPort;
  /** 创建会话时冻结的能力版本快照（id→version）。 */
  capabilityVersions?: Readonly<Record<string, number>>;
  /**
   * WP5A：可注入进程运行状态/readiness（生产组合 startServer 总是注入真实对象并维护
   * ready/gate verified；未注入时缺省为未就绪对象——仅测试/非生产组合使用，恒 503/ready 0，
   * 绝不误报就绪）。
   */
  ops?: OperationStatus;
};

const DEFAULT_CONCURRENCY = {
  globalLimit: 20,
  perUserLimit: 2,
  perUserQueueLimit: 10,
  globalQueueLimit: 100,
  queueTimeoutMs: 5 * 60 * 1000,
};

const TITLE_BODY_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  additionalProperties: false,
} as const;
const RENAME_BODY_SCHEMA = { ...TITLE_BODY_SCHEMA, required: ["title"] } as const;
const MESSAGES_BODY_SCHEMA = {
  type: "object",
  properties: {
    requestId: { type: "string" },
    prompt: { type: "string" },
    parentId: { type: "string" },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: { mediaType: { type: "string" }, base64: { type: "string" } },
        required: ["mediaType", "base64"],
        additionalProperties: false,
      },
    },
  },
  required: ["requestId", "prompt"],
  additionalProperties: false,
} as const;
const TEXT_BODY_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;
const CREATE_PROJECT_BODY_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, cwd: { type: "string" } },
  required: ["name", "cwd"],
  additionalProperties: false,
} as const;
// 创建会话与 PATCH config 的模型/思考级别校验语义一致：模型成对、非空、thinkingLevel 枚举。
const MODEL_CONFIG_PROPERTIES = {
  modelProvider: { type: "string", minLength: 1 },
  modelId: { type: "string", minLength: 1 },
  thinkingLevel: { type: "string", enum: [...THINKING_LEVELS] },
} as const;

const SESSION_CONFIG_BODY_SCHEMA = {
  type: "object",
  properties: MODEL_CONFIG_PROPERTIES,
  additionalProperties: false,
} as const;

const SESSIONS_BODY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    projectId: { type: "string" },
    ...MODEL_CONFIG_PROPERTIES,
  },
  dependencies: {
    modelProvider: ["modelId"],
    modelId: ["modelProvider"],
  },
  additionalProperties: false,
} as const;

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  const s = Array.isArray(value) ? value[0] : value;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const NOT_FOUND = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: "Not Found", message: "会话不存在" });
const CONFLICT = (reply: FastifyReply) =>
  reply.code(409).send({ statusCode: 409, error: "Conflict", message: "会话无活动任务或状态不允许" });

function hashIdentity(identity: UserIdentity): string {
  return createHash("sha256").update(identityKey(identity)).digest("hex").slice(0, 16);
}

// WP5D-2 请求日志脱敏（安全 serializer，纵深防线）：Fastify 默认 req serializer 会输出
// method/url/host/headers（透传 XFF 与 Authorization）/remoteAddress/remotePort——
// 这里只保留 request id 与 method；res 只保留 statusCode。即使某个后续代码路径把整个
// request/reply 对象丢进日志，序列化后的行也只剩这些安全字段。
export function safeReqSerializer(request: unknown): { id?: unknown; method?: string } {
  const r = (request ?? {}) as { id?: unknown; method?: unknown };
  return { id: r.id, method: typeof r.method === "string" ? r.method : undefined };
}
export function safeResSerializer(reply: unknown): { statusCode?: number } {
  const r = (reply ?? {}) as { statusCode?: unknown };
  return { statusCode: typeof r.statusCode === "number" ? r.statusCode : undefined };
}

export function buildApp(deps: ServerDeps): FastifyInstance {
  // WP5D-2：ipAccess 运行时严格校验（failfast）——缺失/伪造/字段非法在任何路由注册之前拒绝，
  // JS/typed bypass 与 startServer 同语义。
  const ipAccess = requireIpAccessRuntimeConfig(deps.ipAccess);
  const admission = createAdmission(ipAccess);
  const app = Fastify({
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES ?? 10 * 1024 * 1024),
    // WP5D-2 请求日志红线：Fastify 内置按请求日志（incoming request / request completed /
    // routeNotFound / 默认错误日志等）会序列化 raw remoteAddress/remotePort/url/query/headers
    // （含 X-Forwarded-For 与 Authorization）——一律关闭（disableRequestLogging），改用下方
    // admission 阶段的 subjectHash 安全日志；安全 serializers + redact 作为纵深防线，任何残余
    // 的 { req } 日志也只剩 id/method。绝不记录 IP/url/token。
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      serializers: { req: safeReqSerializer, res: safeResSerializer },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers",
          "headers.authorization",
          "authorization",
          "token",
          "apiKey",
          "req.url",
          "req.query",
          "req.remoteAddress",
          "req.remotePort",
        ],
        censor: "[REDACTED]",
      },
      ...(deps.requestLogStream ? { stream: deps.requestLogStream } : {}),
    },
  });
  const concurrency = deps.concurrency ?? new ConcurrencyController(DEFAULT_CONCURRENCY);
  const registry = deps.registry ?? new RuntimeRegistry({
    concurrency,
    createAdapter: deps.createAdapter,
    idempotencyRepo: deps.idempotencyRepo,
    observability: deps.observability,
  });
  // 关闭中标志：preClose 置真，SSE 路由在 hijack 前检查，拒绝晚建立的连接（避免关闭自锁）。
  let closing = false;
  // WP5A 最小运维门禁基础（与 /health 一样免鉴权，供探针使用）：
  // - /readyz：只报告本进程安全启动完成 + 选用的 migration gate 已通过；effective readiness
  //   failclosed：ready && (gate=off || gate=verify 且校验通过) && dialect 已知，不一致/未知一律 503；
  //   请求路径不做任何迁移/写库；
  // - /metrics：Prometheus text exposition 固定小表面，渲染异常 failclosed 不泄漏；
  //   pi_agent_server_ready 与 effective readiness 一致（不一致/未知 = 0）；
  // - 两者均为 route-level strict GET-only（HEAD 404），不影响 /health 与 /v1 的默认 HEAD 行为；
  // - 缺省 ops 恒未就绪（ready=false、dialect unknown）：未注入 ops 的组合不误报就绪。
  const ops = deps.ops ?? createOperationStatus();
  // WP5A：关闭开始（preClose）即把 readiness 拉低（/readyz → 503、/metrics ready 0）——
  // best-effort 状态回落，不构成任何新的 shutdown 保证（其余关闭行为保持原有语义）。
  app.addHook("preClose", async () => {
    ops.ready = false;
    ops.readyAt = null;
  });
  const sessions = new SessionService({
    sessions: deps.sessions,
    projects: deps.projects,
    registry,
    defaultProjectCwd: deps.defaultProjectCwd,
    defaultProjectName: deps.defaultProjectName,
    modelCatalog: deps.modelCatalog,
    defaultModel: deps.defaultModel,
    defaultThinkingLevel: deps.defaultThinkingLevel,
    systemPrompt: deps.systemPrompt,
    systemPromptResolver: deps.systemPromptResolver,
    capabilityVersions: deps.capabilityVersions,
    sessionHistoryReader: deps.sessionHistoryReader,
    createId: randomUUID,
    now: Date.now,
  });

  const sseConnections = new Map<string, number>();
  const maxSseGlobal = deps.maxSseGlobal ?? 100;
  const maxSsePerUser = deps.maxSsePerUser ?? 10;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SessionDeletedError) {
      return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "会话不存在" });
    }
    reply.send(error);
  });

  // WP5D-2 全局网络准入（onRequest，覆盖 /health、/readyz、/metrics 与 /v1 全部路由）：
  // - 注册顺序关键：必须先于 CORS 插件注册。@fastify/cors 也在 onRequest 层处理预检 OPTIONS
  //   并直接回包；若 CORS 先跑，CIDR 外来源可凭「合法 Origin 的预检」在准入前拿到 200 CORS
  //   响应。准入先跑 → CIDR 外 OPTIONS（含合法 Origin）一律 403，allowed 预检再交回 CORS 正常回 204；
  // - 身份 = 直接 socket IP（canonical，IPv4-mapped 归一 v4）；X-Forwarded-For 与 request.ip 一律不用；
  // - CIDR 外 / disabled / socket IP 不可解析 → 403（unknown socket IP failclosed）；
  // - /v1 且画像 tokenRequired：实际请求与非预检 OPTIONS 缺失/错误 token → 401，带固定
  //   `WWW-Authenticate: Bearer`（无敏感）；合规 CORS 预检免 token，随后交给 CORS origin policy；
  //   403 不带 WWW-Authenticate；token off 时出示的 Bearer 忽略；
  // - 探针仅 IP gate（不要求 token/role）；role 授权由下方 WP5D-3 routeRbacOnRequest 负责；
  // - 401/403 响应体不含原始 IP/token/path；request.user/request.access 是唯一注入点
  //   （access 为 public profile，无 token hashes），日志只带 subjectHash，绝不记录原始 IP/token。
  const UNAUTHORIZED_BODY = { statusCode: 401, error: "Unauthorized", message: "缺少或无效的 Bearer Token" };
  app.addHook("onRequest", async (request, reply) => {
    let result: AdmissionResult;
    try {
      result = admission(request);
    } catch {
      // failclosed：准入层异常一律 403（不泄漏内部信息；日志只用固定枚举，无请求内容）
      request.log.warn(
        { admission: "denied", reason: "internal-error" },
        "network admission failed closed",
      );
      return reply.code(403).send(FORBIDDEN_BODY);
    }
    if (result.verdict === "denied") {
      // 后置安全日志：只带固定枚举与结果码（无 IP/url/token/headers）。
      request.log.info(
        { admission: "denied", reason: result.reason, statusCode: result.statusCode },
        "request denied by network admission",
      );
      if (result.statusCode === 401) {
        return reply.code(401).header("WWW-Authenticate", "Bearer").send(UNAUTHORIZED_BODY);
      }
      return reply.code(403).send(FORBIDDEN_BODY);
    }
    request.user = result.user;
    request.access = result.access;
    request.subjectHash = hashIdentity(result.user);
    const subjectChild = { subjectHash: request.subjectHash };
    request.log = request.log.child(subjectChild);
    reply.log = reply.log.child(subjectChild);
    // 后置安全日志：allowed 只带 subjectHash（无 IP/url/token）。
    request.log.info({ admission: "allowed" }, "request admitted by network admission");
  });

  // CORS origin 归一化（与 @fastify/cors 对齐）：含 "*" 时整体归一化为静态 "*"；
  // 其余来源始终使用数组，让单元素也执行 allowlist 匹配而不是固定回显任意 Origin。
  const rawCorsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const corsOrigins = rawCorsOrigins.includes("*") ? ["*"] : rawCorsOrigins;
  const corsOriginOption: string | string[] | undefined =
    corsOrigins.length === 0 ? undefined : corsOrigins.includes("*") ? "*" : corsOrigins;
  if (corsOriginOption !== undefined) void app.register(cors, { origin: corsOriginOption });
  // WP5D-3 全局角色 gate（onRequest，注册顺序：admission → @fastify/cors → 本 hook）：
  // - 注册于 CORS 之后：@fastify/cors 的 onRequest 对合规预检直接回 204，角色 gate 对预检
  //   从不执行（CORS 预检先做 admission、不做 role/token；实际请求才 role gate）；
  // - default-deny：每路由显式 config.permission（requirePermission），漏接/未知 → 403；
  // - 只读 request.access.role（admission 注入）；缺失/未知/伪造 role → failclosed 403；
  // - 403 固定 FORBIDDEN_BODY（不泄 role/IP/path），拒绝日志只带固定枚举（subjectHash
  //   已由 admission 后置日志携带）。
  app.addHook("onRequest", routeRbacOnRequest);
  app.get("/health", { ...requirePermission("probe:health") }, async () => ({ status: "ok" }));
  // WP5A 运维探针（读进程状态纯函数，零 I/O、零定时器、不触碰存储）：
  // route-level strict GET-only（exposeHeadRoute:false，HEAD 404）；/health 与 /v1 既有路由
  // 的默认 HEAD 行为不变。
  app.get("/readyz", { exposeHeadRoute: false, ...requirePermission("probe:readyz") }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const body = readyzBody(ops);
      return reply.code(body.ready ? 200 : 503).type("application/json; charset=utf-8").send(body);
    } catch {
      // failclosed：状态读取异常时绝不误报 ready，且只返回最小兜底体（无内部细节）。
      return reply.code(503).type("application/json; charset=utf-8").send({
        ready: false,
        migrationGate: "verify",
        schema: "unknown",
      });
    }
  });
  app.get("/metrics", { exposeHeadRoute: false, ...requirePermission("probe:metrics") }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const body = renderMetrics(ops, Date.now());
      return reply.type("text/plain; version=0.0.4; charset=utf-8").send(body);
    } catch {
      // failclosed：渲染异常返回空 503（无堆栈/无内部字段），绝不让异常内容泄漏。
      return reply.code(503).type("text/plain; charset=utf-8").send("");
    }
  });
  const ownerKeyOf = (request: { user: UserIdentity }) => identityKey(request.user);

  app.register(async (api) => {
    api.get("/models", { ...requirePermission("models:list") }, async () => sessions.models());
    api.get("/projects", { ...requirePermission("projects:list") }, async (request) => sessions.listProjects(ownerKeyOf(request)));
    api.post<{ Body: { name: string; cwd: string } }>(
      "/projects",
      { schema: { body: CREATE_PROJECT_BODY_SCHEMA }, ...requirePermission("projects:create") },
      async (request, reply) => {
        const project = await sessions.createProject(ownerKeyOf(request), request.body);
        return project
          ? reply.code(201).send(project)
          : reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "name 与 cwd 不能为空" });
      },
    );
    api.delete<{ Params: { id: string } }>("/projects/:id", { ...requirePermission("projects:delete") }, async (request, reply) => {
      switch (await sessions.deleteProject(ownerKeyOf(request), request.params.id)) {
        case "default":
          return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "默认项目不可删除" });
        case "not-found":
          return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "项目不存在" });
        case "deleted":
          return reply.code(204).send();
      }
    });

    api.post<{ Body: { title?: string; projectId?: string; modelProvider?: string; modelId?: string; thinkingLevel?: string } }>(
      "/sessions",
      { schema: { body: SESSIONS_BODY_SCHEMA }, ...requirePermission("sessions:create") },
      async (request, reply) => {
        const result = await sessions.createSession(ownerKeyOf(request), request.body);
        switch (result.kind) {
          case "created":
            return reply.code(201).send(result.session);
          case "project-not-found":
            return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "项目不存在" });
          case "invalid-model":
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "模型不可用" });
          case "invalid-thinking-level":
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "thinkingLevel 必须是 off/minimal/low/medium/high/xhigh/max 之一" });
          case "model-check-failed":
            return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", message: "模型可用性检查失败" });
        }
      },
    );
    api.get<{ Querystring: { projectId?: string } }>("/sessions", { ...requirePermission("sessions:list") }, async (request) =>
      sessions.listSessions(ownerKeyOf(request), request.query.projectId));
    api.delete<{ Params: { id: string } }>("/sessions/:id", { ...requirePermission("sessions:delete") }, async (request, reply) =>
      (await sessions.deleteSession(ownerKeyOf(request), request.params.id)) ? reply.code(204).send() : NOT_FOUND(reply));
    api.patch<{ Params: { id: string }; Body: { title: string } }>(
      "/sessions/:id",
      { schema: { body: RENAME_BODY_SCHEMA }, ...requirePermission("sessions:update") },
      async (request, reply) => {
        const session = await sessions.renameSession(ownerKeyOf(request), request.params.id, request.body.title);
        return session ? reply.code(200).send(session) : NOT_FOUND(reply);
      },
    );
    api.patch<{ Params: { id: string }; Body: { modelProvider?: string; modelId?: string; thinkingLevel?: string } }>(
      "/sessions/:id/config",
      { schema: { body: SESSION_CONFIG_BODY_SCHEMA }, ...requirePermission("sessions:update-config") },
      async (request, reply) => {
        const result = await sessions.configureSession(ownerKeyOf(request), request.params.id, request.body);
        switch (result.kind) {
          case "updated": return reply.code(200).send(result.session);
          case "not-found": return NOT_FOUND(reply);
          case "model-pair-required":
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "modelProvider 与 modelId 必须同时提供" });
          case "invalid-thinking-level":
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "thinkingLevel 必须是 off/minimal/low/medium/high/xhigh/max 之一" });
          case "invalid-model":
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "模型不可用" });
          case "model-check-failed":
            return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", message: "模型可用性检查失败" });
        }
      },
    );
    api.post<{ Params: { id: string }; Body: { requestId: string; prompt: string; parentId?: string; images?: { mediaType: string; base64: string }[] } }>(
      "/sessions/:id/messages",
      { schema: { body: MESSAGES_BODY_SCHEMA }, ...requirePermission("sessions:send-message") },
      async (request, reply) => {
        const result = await sessions.submitMessage(ownerKeyOf(request), request.params.id, request.body);
        if (!result.found) return NOT_FOUND(reply);
        switch (result.decision.kind) {
          case "run": return reply.code(202).send({ status: "accepted" });
          case "queued": return reply.code(202).send({ status: "queued", position: result.decision.position });
          case "rejected": return reply.code(429).send({ statusCode: 429, error: "Too Many Requests", message: result.decision.reason === "user-queue-full" ? "用户队列已满" : "服务过载，请稍后重试" });
          case "conflict": return reply.code(409).send({ statusCode: 409, error: "Conflict", message: result.decision.reason === "poisoned" ? "会话任务异常，请新建会话" : "会话已有活动任务" });
          case "done": return reply.code(200).send(result.decision.result);
        }
      },
    );
    api.get<{ Params: { id: string } }>("/sessions/:id/export", { ...requirePermission("sessions:export") }, async (request, reply) => {
      const exported = await sessions.exportSession(ownerKeyOf(request), request.params.id);
      return exported ? reply.code(200).send(exported) : NOT_FOUND(reply);
    });
    for (const [path, operation, hasText] of [
      ["/sessions/:id/steer", "steer", true],
      ["/sessions/:id/follow-ups", "follow-up", true],
      ["/sessions/:id/abort", "abort", false],
    ] as const) {
      api.post<{ Params: { id: string }; Body: { text: string } }>(
        path,
        { ...(hasText ? { schema: { body: TEXT_BODY_SCHEMA } } : {}), ...requirePermission("sessions:control") },
        async (request, reply) => {
        const result = await sessions.controlSession(ownerKeyOf(request), request.params.id, operation, hasText ? request.body.text : undefined);
        return result === "not-found" ? NOT_FOUND(reply) : result === "ok" ? reply.code(204).send() : CONFLICT(reply);
      });
    }

    // SSE is a transport concern: headers, connection limits, heartbeats and byte backpressure stay in HTTP.
    api.get<{ Params: { id: string } }>("/sessions/:id/events", { ...requirePermission("sessions:events") }, async (request, reply) => {
      // WP5D-3 P2 顺序红线：关闭检查与配额检查+占位必须在任何 runtime 创建/查询**之前**同步完成
      // ——429/503 及后续所有拒绝路径零 adapter/DB/piSessionFile 副作用。
      // 关闭中：拒绝建立新 SSE 连接，避免 preClose 之后晚建立的连接阻塞 close。
      if (closing) {
        return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", message: "服务正在关闭" });
      }
      const subjectHash = request.subjectHash;
      const userCount = sseConnections.get(subjectHash) ?? 0;
      const globalCount = [...sseConnections.values()].reduce((a, b) => a + b, 0);
      if (userCount >= maxSsePerUser || globalCount >= maxSseGlobal) {
        return reply.code(429).send({ statusCode: 429, error: "Too Many Requests", message: "SSE 连接过多，请稍后重试" });
      }
      // 配额检查与占位在同一同步块内完成（首个 await 之前）：Node 单线程事件循环下检查与占位
      // 之间不可能插入其他请求的处理——并发请求无法在检查后、占位前挤入，上限不可绕过；
      // 占位成功后，任何拒绝/异常路径（204/404/查询异常/socket 工厂失败等 pre-stream 失败）
      // 必须恰释放一次（releaseSlot 幂等），成功连接则由连接清理（cleanup）恰释放一次。
      sseConnections.set(subjectHash, userCount + 1);
      let slotReleased = false;
      function releaseSlot(): void {
        if (slotReleased) return;
        slotReleased = true;
        const c = sseConnections.get(subjectHash) ?? 1;
        if (c <= 1) sseConnections.delete(subjectHash);
        else sseConnections.set(subjectHash, c - 1);
      }
      // 入口解析（关闭/配额之后）：viewer 只 registry.getExisting——绝不创建 runtime，
      // 记录存在但无 runtime 时返回稳定受控态 204（无可订阅的 live 事件流；文档见
      // needs.md §8 / README API 表）；user/admin 保持 getOrCreate（懒实例化）。
      // operator 已在路由 role gate 被拒，不会到达此处。
      let found: SessionEntry;
      try {
        if (request.access.role === "viewer") {
          const result = await sessions.getExistingEntry(ownerKeyOf(request), request.params.id);
          if (result.kind === "not-found") {
            releaseSlot(); // 未建立流：释放占位（响应与未占位路径一致；占位不残留）
            return NOT_FOUND(reply);
          }
          if (result.kind === "no-runtime") {
            // 稳定受控态：不创建、不订阅、零副作用（与 404 区分：会话存在但无 live 流）。
            releaseSlot(); // 未建立流：释放占位
            return reply.code(204).send();
          }
          found = result.entry;
        } else {
          const entry = await sessions.getEntry(ownerKeyOf(request), request.params.id);
          if (!entry) {
            releaseSlot(); // 未建立流：释放占位
            return NOT_FOUND(reply);
          }
          found = entry;
        }
      } catch (error) {
        // getExisting/getOrCreate 异常：释放占位后交给框架 500（不吞异常；占位不残留）
        releaseSlot();
        throw error;
      }
      const { events } = found;
      const lastEventId = parseLastEventId(request.headers["last-event-id"]);
      const clientEpoch = request.headers["x-client-epoch"];
      const effectiveLastEventId = Boolean(deps.serverEpoch) && clientEpoch !== undefined && clientEpoch !== deps.serverEpoch ? 0 : lastEventId;
      reply.hijack();
      // socket 工厂失败：释放占位并手动关闭底层连接，避免客户端挂起无响应
      let socket: SseSocket;
      try {
        socket = (deps.sseSocketFactory ?? defaultSseSocket)(reply.raw, request.raw);
      } catch {
        releaseSlot();
        reply.raw.destroy();
        return;
      }
      const backpressureThreshold = deps.sseBackpressureThreshold ?? SSE_BACKPRESSURE_THRESHOLD;
      let backpressure = 0;
      let shouldClose = false;
      let cleaned = false;
      let unsubscribe: () => void = () => {};
      let unregisterClose: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      function cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        unregisterClose();
        releaseSlot(); // 成功连接：清理时释放占位恰一次（幂等）
      }
      // 统一关闭：清理配额/订阅并关闭底层连接，异常隔离（任何失败路径都可安全调用，幂等）
      function safeClose(): void {
        cleanup();
        try { socket.end(); } catch { /* 忽略：底层连接已不可用 */ }
      }
      // 尽早注册 close：覆盖 writeHead/补发期间客户端断开的窗口
      try {
        socket.onClose(cleanup);
      } catch {
        safeClose();
        return;
      }
      // 防御：客户端在占位后、onClose 注册前已断开（close 事件已不可达）→ 立即清理，避免配额泄漏
      if (request.raw.destroyed || request.raw.aborted || reply.raw.destroyed) {
        safeClose();
        return;
      }
      // CORS 与 @fastify/cors 对齐：静态 origin 仅用于 "*"；动态 allowlist 命中才回显并声明 Vary；
      // 未命中/无 origin 不发 ACAO。
      const requestOrigin = request.headers.origin;
      const sseStaticOrigin = corsOriginOption === "*" ? "*" : undefined;
      const sseDynamicOrigins = Array.isArray(corsOriginOption) ? corsOriginOption : [];
      const allowOrigin = sseStaticOrigin !== undefined
        ? sseStaticOrigin
        : sseDynamicOrigins.length > 0 && typeof requestOrigin === "string" && sseDynamicOrigins.includes(requestOrigin)
          ? requestOrigin
          : undefined;
      try {
        socket.writeHead(200, {
          "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
          // hijack 后绕过 Fastify 响应流程，需手动带上 CORS 头（浏览器跨域直连时必需）。
          ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
          ...(sseDynamicOrigins.length > 0 ? { Vary: "Origin" } : {}),
          ...(deps.serverEpoch ? { "X-Server-Epoch": deps.serverEpoch } : {}),
        });
        socket.flushHeaders();
      } catch {
        safeClose();
        return;
      }
      function writeRaw(data: string): boolean {
        if (cleaned) return false;
        let ok: boolean;
        try {
          ok = socket.write(data);
        } catch {
          // 写失败（底层连接已坏）：标记应关闭，不抛异常（heartbeat/subscribe 回调内不得冒泡）
          shouldClose = true;
          return false;
        }
        const state = nextBackpressureState(backpressure, ok, backpressureThreshold);
        backpressure = state.backpressure;
        if (state.shouldClose) shouldClose = true;
        return ok;
      }
      function maybeClose(): void {
        if (shouldClose && !cleaned) safeClose();
      }
      heartbeat = setInterval(() => { writeRaw(": ping\n\n"); maybeClose(); }, 15000);
      let subscribed = false;
      unsubscribe = events.subscribe(({ id, event }) => {
        if (shouldClose || cleaned) return;
        writeRaw(formatSseEvent(id, event));
        if (subscribed) maybeClose();
      }, effectiveLastEventId);
      subscribed = true;
      maybeClose();
      if (cleaned) return;
      unregisterClose = events.registerClose(() => { safeClose(); });
    });
  }, { prefix: "/v1" });

  const SHUTDOWN_GRACE_MS = 30_000;
  // 先关闭所有 SSE 长连接，避免活跃 hijack socket 阻塞 server close（自锁）；
  // 置 closing 标志，拒绝 preClose 之后晚建立的 SSE（异步初始化中的请求会在 hijack 前被拦）。
  app.addHook("preClose", async () => {
    closing = true;
    registry.closeAllEvents();
  });
  app.addHook("onClose", async () => {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (concurrency.activeCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await registry.abortAll();
    registry.dispose();
  });
  return app;
}
