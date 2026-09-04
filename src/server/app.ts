// HTTP composition root: Fastify concerns (authentication, validation, response mapping, SSE, CORS and shutdown)
// remain here; session/project application behavior is implemented by SessionService.

import { randomUUID, createHash } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import { identityKey, type UserIdentity } from "../core/user-identity.js";
import { ConcurrencyController } from "../core/concurrency-control.js";
import type { AgentAdapter } from "../agent/agent-adapter.js";
import type {
  IdempotencyStorePort,
  ModelCatalogPort,
  ModelDescriptor,
  ObservabilityPort,
  ProjectStorePort,
  SessionStorePort,
  SystemPromptPort,
} from "../application/ports/index.js";
import { RuntimeRegistry, SessionDeletedError } from "../runtime/runtime-registry.js";
import { SessionService, THINKING_LEVELS } from "../application/session-service.js";
import type { Authenticate } from "./auth.js";
import { formatSseEvent } from "./sse-format.js";
import { nextBackpressureState, SSE_BACKPRESSURE_THRESHOLD } from "./sse-backpressure.js";
import { defaultSseSocket, type SseReplyRaw, type SseRequestRaw, type SseSocket } from "./sse-socket.js";

export type ServerDeps = {
  sessions: SessionStorePort;
  authenticate: Authenticate;
  projects: ProjectStorePort;
  defaultProjectCwd: string;
  defaultProjectName?: string;
  modelCatalog?: ModelCatalogPort;
  defaultModel?: ModelDescriptor | null;
  defaultThinkingLevel?: string;
  createAdapter: (sessionId: string) => Promise<AgentAdapter>;
  concurrency?: ConcurrencyController;
  trustProxy?: string | string[] | boolean;
  idempotencyRepo?: IdempotencyStorePort;
  /** 观测订阅口（可选；关键路径推送脱敏观测事件）。 */
  observability?: ObservabilityPort;
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

export function buildApp(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES ?? 10 * 1024 * 1024),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: ["req.headers.authorization", "token", "apiKey"], censor: "[REDACTED]" },
    },
  });
  const concurrency = deps.concurrency ?? new ConcurrencyController(DEFAULT_CONCURRENCY);
  const registry = new RuntimeRegistry({
    concurrency,
    createAdapter: deps.createAdapter,
    idempotencyRepo: deps.idempotencyRepo,
    observability: deps.observability,
  });
  // 关闭中标志：preClose 置真，SSE 路由在 hijack 前检查，拒绝晚建立的连接（避免关闭自锁）。
  let closing = false;
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

  // CORS origin 归一化（与 @fastify/cors 对齐）：含 "*" 时整体归一化为静态 "*"；
  // 单元素用 string（静态，固定回显）；多元素用数组（动态，命中回显 + Vary）。
  const rawCorsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const corsOrigins = rawCorsOrigins.includes("*") ? ["*"] : rawCorsOrigins;
  const corsOriginOption: string | string[] | undefined =
    corsOrigins.length === 0 ? undefined : corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins;
  if (corsOriginOption !== undefined) void app.register(cors, { origin: corsOriginOption });
  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (api) => {
    api.addHook("onRequest", async (request, reply) => {
      let identity;
      try {
        identity = await deps.authenticate(request);
      } catch {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "缺少或无效的 Bearer Token",
        });
      }
      request.user = identity;
      request.subjectHash = hashIdentity(identity);
      const subjectChild = { subjectHash: request.subjectHash };
      request.log = request.log.child(subjectChild);
      reply.log = reply.log.child(subjectChild);
    });
    const ownerKeyOf = (request: { user: UserIdentity }) => identityKey(request.user);

    api.get("/models", async () => sessions.models());
    api.get("/projects", async (request) => sessions.listProjects(ownerKeyOf(request)));
    api.post<{ Body: { name: string; cwd: string } }>(
      "/projects",
      { schema: { body: CREATE_PROJECT_BODY_SCHEMA } },
      async (request, reply) => {
        const project = await sessions.createProject(ownerKeyOf(request), request.body);
        return project
          ? reply.code(201).send(project)
          : reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "name 与 cwd 不能为空" });
      },
    );
    api.delete<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
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
      { schema: { body: SESSIONS_BODY_SCHEMA } },
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
    api.get<{ Querystring: { projectId?: string } }>("/sessions", async (request) =>
      sessions.listSessions(ownerKeyOf(request), request.query.projectId));
    api.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) =>
      (await sessions.deleteSession(ownerKeyOf(request), request.params.id)) ? reply.code(204).send() : NOT_FOUND(reply));
    api.patch<{ Params: { id: string }; Body: { title: string } }>(
      "/sessions/:id",
      { schema: { body: RENAME_BODY_SCHEMA } },
      async (request, reply) => {
        const session = await sessions.renameSession(ownerKeyOf(request), request.params.id, request.body.title);
        return session ? reply.code(200).send(session) : NOT_FOUND(reply);
      },
    );
    api.patch<{ Params: { id: string }; Body: { modelProvider?: string; modelId?: string; thinkingLevel?: string } }>(
      "/sessions/:id/config",
      { schema: { body: SESSION_CONFIG_BODY_SCHEMA } },
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
      { schema: { body: MESSAGES_BODY_SCHEMA } },
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
    api.get<{ Params: { id: string } }>("/sessions/:id/export", async (request, reply) => {
      const exported = await sessions.exportSession(ownerKeyOf(request), request.params.id);
      return exported ? reply.code(200).send(exported) : NOT_FOUND(reply);
    });
    for (const [path, operation, hasText] of [
      ["/sessions/:id/steer", "steer", true],
      ["/sessions/:id/follow-ups", "follow-up", true],
      ["/sessions/:id/abort", "abort", false],
    ] as const) {
      api.post<{ Params: { id: string }; Body: { text: string } }>(path, hasText ? { schema: { body: TEXT_BODY_SCHEMA } } : {}, async (request, reply) => {
        const result = await sessions.controlSession(ownerKeyOf(request), request.params.id, operation, hasText ? request.body.text : undefined);
        return result === "not-found" ? NOT_FOUND(reply) : result === "ok" ? reply.code(204).send() : CONFLICT(reply);
      });
    }

    // SSE is a transport concern: headers, connection limits, heartbeats and byte backpressure stay in HTTP.
    api.get<{ Params: { id: string } }>("/sessions/:id/events", async (request, reply) => {
      const found = await sessions.getEntry(ownerKeyOf(request), request.params.id);
      if (!found) return NOT_FOUND(reply);
      // 关闭中：拒绝建立新 SSE 连接，避免 preClose 之后晚建立的连接阻塞 close
      if (closing) {
        return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", message: "服务正在关闭" });
      }
      const { events } = found;
      const subjectHash = request.subjectHash;
      const userCount = sseConnections.get(subjectHash) ?? 0;
      const globalCount = [...sseConnections.values()].reduce((a, b) => a + b, 0);
      if (userCount >= maxSsePerUser || globalCount >= maxSseGlobal) {
        return reply.code(429).send({ statusCode: 429, error: "Too Many Requests", message: "SSE 连接过多，请稍后重试" });
      }
      const lastEventId = parseLastEventId(request.headers["last-event-id"]);
      const clientEpoch = request.headers["x-client-epoch"];
      const effectiveLastEventId = Boolean(deps.serverEpoch) && clientEpoch !== undefined && clientEpoch !== deps.serverEpoch ? 0 : lastEventId;
      reply.hijack();
      // socket 工厂先于配额：工厂失败不占用配额
      let socket: SseSocket;
      try {
        socket = (deps.sseSocketFactory ?? defaultSseSocket)(reply.raw, request.raw);
      } catch {
        // hijack 后需手动关闭底层连接，避免客户端挂起无响应
        reply.raw.destroy();
        return;
      }
      const backpressureThreshold = deps.sseBackpressureThreshold ?? SSE_BACKPRESSURE_THRESHOLD;
      sseConnections.set(subjectHash, userCount + 1);
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
        const c = sseConnections.get(subjectHash) ?? 1;
        if (c <= 1) sseConnections.delete(subjectHash);
        else sseConnections.set(subjectHash, c - 1);
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
      // CORS 与 @fastify/cors 对齐：静态 origin（string，含 "*"）固定回显；
      // 动态 origin（数组）命中才回显并声明 Vary；未命中/无 origin 不发 ACAO。
      const requestOrigin = request.headers.origin;
      const sseStaticOrigin = typeof corsOriginOption === "string" ? corsOriginOption : undefined;
      const sseDynamicOrigins = Array.isArray(corsOriginOption) ? corsOriginOption : [];
      const allowOrigin = sseStaticOrigin !== undefined
        ? sseStaticOrigin
        : sseDynamicOrigins.length > 0 && requestOrigin && sseDynamicOrigins.includes(requestOrigin)
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
