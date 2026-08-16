// HTTP 层组装（README §4.2 / docs/architecture.md 数据流 ①②③）
// buildApp(deps) 工厂：注入 SessionRepository 与 authenticate，
// 构建 Fastify 实例并注册会话 CRUD 与健康检查路由。
// 业务路由封装在 /v1 前缀的独立 scope 内，鉴权 onRequest hook 只作用于该 scope
// （Fastify 封装隔离）；hook 失败返回 401；会话归属校验在路由内，非本人视为 404。

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import { identityKey, type UserIdentity } from "../core/user-identity.js";
import { ConcurrencyController } from "../core/concurrency-control.js";
import type { AgentAdapter } from "../agent/agent-adapter.js";
import type { SessionRecord, SessionRepository } from "../storage/session-repository.js";
import { RuntimeRegistry, SessionDeletedError } from "../runtime/runtime-registry.js";
import type { IdempotencyRepository } from "../storage/idempotency-repository.js";
import type { Authenticate } from "./auth.js";
import { formatSseEvent } from "./sse-format.js";

export type ServerDeps = {
  sessions: SessionRepository;
  authenticate: Authenticate;
  /** 按 sessionId 异步创建 Agent 适配器（真实 Pi SDK 的 createAgentSession 为异步）。 */
  createAdapter: (sessionId: string) => Promise<AgentAdapter>;
  /** 并发控制器（默认每用户 2、全局 20，见 README §4.2）。 */
  concurrency?: ConcurrencyController;
  /** 可信代理 IP 列表（配置后 request.ip 取 X-Forwarded-For 真实来源；默认 false 只信 TCP 对端，避免伪造 IP 绕过内网免登录）。 */
  trustProxy?: string | string[] | boolean;
  /** 幂等记录持久化后端（可选；提供则重启后重复 requestId 返回原结果）。 */
  idempotencyRepo?: IdempotencyRepository;
  /** 服务启动纪元（每次启动生成，用于 SSE 客户端检测重启后 cursor 失效）。 */
  serverEpoch?: string;
};

const NOW = () => Date.now();

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

const RENAME_BODY_SCHEMA = {
  ...TITLE_BODY_SCHEMA,
  required: ["title"],
} as const;

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
        properties: {
          mediaType: { type: "string" },
          base64: { type: "string" },
        },
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

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  const s = Array.isArray(value) ? value[0] : value;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const NOT_FOUND = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: "Not Found", message: "会话不存在" });

// subjectHash：脱敏用户主体标识（README §5.2），用于按用户聚合限流/成本/滥用，不记录原始 IP/账号
function hashIdentity(identity: UserIdentity): string {
  return createHash("sha256").update(identityKey(identity)).digest("hex").slice(0, 16);
}

const CONFLICT = (reply: FastifyReply) =>
  reply.code(409).send({ statusCode: 409, error: "Conflict", message: "会话无活动任务或状态不允许" });

// API DTO：不暴露内部 piSessionFile 绝对路径（review P2）
function toSessionDto(record: SessionRecord): Omit<SessionRecord, "piSessionFile"> {
  const { piSessionFile: _piSessionFile, ...dto } = record;
  return dto;
}

export function buildApp(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    trustProxy: deps.trustProxy ?? false,
    // 请求体大小限制（README §7）：默认 1MB，支持图片可调大
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES ?? 10 * 1024 * 1024),
    // 日志设计（README §5）：单行 JSON、LOG_LEVEL 可配、序列化阶段脱敏
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: ["req.headers.authorization", "token", "apiKey"],
        censor: "[REDACTED]",
      },
    },
  });

  const concurrency = deps.concurrency ?? new ConcurrencyController(DEFAULT_CONCURRENCY);
  const registry = new RuntimeRegistry({
    concurrency,
    createAdapter: deps.createAdapter,
    idempotencyRepo: deps.idempotencyRepo,
  });

  // SSE 连接上限（README §7 限流）：全局 + 每用户（subjectHash）计数，超限返回 429
  const sseConnections = new Map<string, number>();
  const MAX_SSE_GLOBAL = 100;
  const MAX_SSE_PER_USER = 10;

  // 统一错误处理：会话已删除（墓碑）→ 404，避免各路由重复 try/catch
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SessionDeletedError) {
      return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "会话不存在" });
    }
    reply.send(error);
  });

  // CORS 白名单（README §7）：逗号分隔的允许源，空则默认同源（不跨域）
  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins.length > 0) {
    void app.register(cors, { origin: corsOrigins });
  }

  // 健康检查：无需鉴权，注册在业务 scope 之外
  app.get("/health", async () => ({ status: "ok" }));

  // 业务 API（/v1，README §4.2）：独立封装 scope，鉴权 hook 仅作用于其中的路由
  app.register(
    async (api) => {
      // 鉴权：所有业务路由经 Bearer Token，失败返回 401
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
        // 子 logger 携带 subjectHash，request/reply 都绑定（Fastify 的 request completed 日志用 reply.log）
        const subjectChild = { subjectHash: request.subjectHash };
        request.log = request.log.child(subjectChild);
        reply.log = reply.log.child(subjectChild);
      });

      const ownerKeyOf = (request: FastifyRequest) => identityKey(request.user);
      const findOwned = async (
        request: FastifyRequest,
        id: string,
      ): Promise<SessionRecord | null> => {
        const record = await deps.sessions.get(id);
        return record && record.ownerKey === ownerKeyOf(request) ? record : null;
      };

      // 校验归属 + 获取/创建 runtime；会话已删除（墓碑）或不存在时返回 null
      const findEntry = async (
        request: FastifyRequest,
        id: string,
      ): Promise<{ entry: Awaited<ReturnType<RuntimeRegistry["getOrCreate"]>>; record: SessionRecord } | null> => {
        const record = await findOwned(request, id);
        if (!record) return null;
        try {
          const entry = await registry.getOrCreate(id, record.ownerKey);
          return { entry, record };
        } catch (error) {
          if (error instanceof SessionDeletedError) return null;
          throw error;
        }
      };

      // POST /v1/sessions 创建会话
      api.post<{ Body: { title?: string } }>(
        "/sessions",
        { schema: { body: TITLE_BODY_SCHEMA } },
        async (request, reply) => {
          const now = NOW();
          const record: SessionRecord = {
            id: randomUUID(),
            ownerKey: ownerKeyOf(request),
            title: request.body.title ?? "",
            createdAt: now,
            updatedAt: now,
            piSessionFile: null,
          };
          await deps.sessions.create(record);
          return reply.code(201).send(toSessionDto(record));
        },
      );

      // GET /v1/sessions 会话列表（按 updatedAt 降序）
      api.get("/sessions", async (request) =>
        (await deps.sessions.listByOwner(ownerKeyOf(request))).map(toSessionDto),
      );

      // DELETE /v1/sessions/:id 仅本人可删，否则 404；删除时中止在途任务、清理 runtime 与 JSONL
      api.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
        const id = request.params.id;
        const record = await findOwned(request, id);
        if (!record) return NOT_FOUND(reply);

        // 先 registry.delete：墓碑最先加入（阻断并发 getOrCreate 重建）+ 清理 runtime/事件总线
        await registry.delete(id);
        // 再删 SQLite（失败则 JSONL 仍在，重启后能一致恢复；墓碑仍阻止当前进程重建）
        await deps.sessions.delete(id);
        // 最后删 JSONL（失败不阻塞，孤儿文件可接受）
        if (record.piSessionFile) {
          await unlink(record.piSessionFile).catch(() => {});
        }
        return reply.code(204).send();
      });

      // PATCH /v1/sessions/:id 重命名，仅本人可改，否则 404
      api.patch<{ Params: { id: string }; Body: { title: string } }>(
        "/sessions/:id",
        { schema: { body: RENAME_BODY_SCHEMA } },
        async (request, reply) => {
          const id = request.params.id;
          const record = await findOwned(request, id);
          if (!record) return NOT_FOUND(reply);
          await deps.sessions.update(id, { title: request.body.title, updatedAt: NOW() });
          const updated = await deps.sessions.get(id);
          return updated ? toSessionDto(updated) : NOT_FOUND(reply);
        },
      );

      // POST /v1/sessions/:id/messages 发送输入（幂等 + 状态机 + 并发 + 异步流式）
      api.post<{
        Params: { id: string };
        Body: {
          requestId: string;
          prompt: string;
          parentId?: string;
          images?: { mediaType: string; base64: string }[];
        };
      }>(
        "/sessions/:id/messages",
        { schema: { body: MESSAGES_BODY_SCHEMA } },
        async (request, reply) => {
          const found = await findEntry(request, request.params.id);
          if (!found) return NOT_FOUND(reply);
          const { runtime } = found.entry;
          const decision = await runtime.submitMessage({
            requestId: request.body.requestId,
            userId: identityKey(request.user),
            prompt: request.body.prompt,
            parentId: request.body.parentId,
            images: request.body.images,
          });
          switch (decision.kind) {
            case "run":
              return reply.code(202).send({ status: "accepted" });
            case "queued":
              return reply.code(202).send({ status: "queued", position: decision.position });
            case "rejected":
              return reply.code(429).send({
                statusCode: 429,
                error: "Too Many Requests",
                message:
                  decision.reason === "user-queue-full" ? "用户队列已满" : "服务过载，请稍后重试",
              });
            case "conflict":
              return reply.code(409).send({
                statusCode: 409,
                error: "Conflict",
                message:
                  decision.reason === "poisoned"
                    ? "会话任务异常，请新建会话"
                    : "会话已有活动任务",
              });
            case "done":
              return reply.code(200).send(decision.result);
          }
        },
      );

      // GET /v1/sessions/:id/export 导出会话（仅本人可见，README §4.2）：
      // 返回 { messages: 扁平化历史, lastEventId: 事件总线快照 cursor }，客户端据此订阅增量避免重复。
      api.get<{ Params: { id: string } }>("/sessions/:id/export", async (request, reply) => {
        const found = await findEntry(request, request.params.id);
        if (!found) return NOT_FOUND(reply);
        const entry = found.entry;
        // 先快照事件 cursor，再读历史消息：快照后的事件由 SSE 按 cursor 补发，避免丢增量
        const lastEventId = entry.events.lastEventId;
        const messages = await entry.runtime.exportSession();
        return reply.code(200).send({ messages, lastEventId });
      });

      // POST /v1/sessions/:id/steer 流式中插入指令
      api.post<{ Params: { id: string }; Body: { text: string } }>(
        "/sessions/:id/steer",
        { schema: { body: TEXT_BODY_SCHEMA } },
        async (request, reply) => {
          const found = await findEntry(request, request.params.id);
          if (!found) return NOT_FOUND(reply);
          const { runtime } = found.entry;
          const d = await runtime.steer(request.body.text);
          return d.kind === "ok" ? reply.code(204).send() : CONFLICT(reply);
        },
      );

      // POST /v1/sessions/:id/follow-ups 流式中追加指令
      api.post<{ Params: { id: string }; Body: { text: string } }>(
        "/sessions/:id/follow-ups",
        { schema: { body: TEXT_BODY_SCHEMA } },
        async (request, reply) => {
          const found = await findEntry(request, request.params.id);
          if (!found) return NOT_FOUND(reply);
          const { runtime } = found.entry;
          const d = await runtime.followUp(request.body.text);
          return d.kind === "ok" ? reply.code(204).send() : CONFLICT(reply);
        },
      );

      // POST /v1/sessions/:id/abort 中止当前任务
      api.post<{ Params: { id: string } }>("/sessions/:id/abort", async (request, reply) => {
        const found = await findEntry(request, request.params.id);
        if (!found) return NOT_FOUND(reply);
        const { runtime } = found.entry;
        const d = await runtime.abort();
        return d.kind === "ok" ? reply.code(204).send() : CONFLICT(reply);
      });

      // GET /v1/sessions/:id/events SSE 订阅事件（带 Last-Event-ID 续传）
      api.get<{ Params: { id: string } }>("/sessions/:id/events", async (request, reply) => {
        const found = await findEntry(request, request.params.id);
        if (!found) return NOT_FOUND(reply);
        const { events } = found.entry;

        // 连接上限（README §7）：全局 + 每用户计数，超限 429
        const subjectHash = request.subjectHash;
        const userCount = sseConnections.get(subjectHash) ?? 0;
        const globalCount = [...sseConnections.values()].reduce((a, b) => a + b, 0);
        if (userCount >= MAX_SSE_PER_USER || globalCount >= MAX_SSE_GLOBAL) {
          return reply.code(429).send({
            statusCode: 429,
            error: "Too Many Requests",
            message: "SSE 连接过多，请稍后重试",
          });
        }
        sseConnections.set(subjectHash, userCount + 1);

        const lastEventId = parseLastEventId(request.headers["last-event-id"]);
        // 客户端携带的 epoch 与服务端不一致（服务重启导致事件 ID 重置）：忽略旧 cursor 从头补发
        const clientEpoch = request.headers["x-client-epoch"];
        const epochMismatch =
          Boolean(deps.serverEpoch) &&
          clientEpoch !== undefined &&
          clientEpoch !== deps.serverEpoch;
        const effectiveLastEventId = epochMismatch ? 0 : lastEventId;

        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          // 启动纪元：客户端据此检测服务重启后事件 ID 已重置，需清空 cursor 从头补发
          ...(deps.serverEpoch ? { "X-Server-Epoch": deps.serverEpoch } : {}),
        });
        reply.raw.flushHeaders();

        let backpressure = 0;
        let shouldClose = false;
        let cleaned = false;
        let unsubscribe: () => void = () => {};
        let unregisterClose: () => void = () => {};

        // 统一写出口：事件与 heartbeat 都纳入 backpressure 统计，慢/失读客户端超阈值断开
        function writeRaw(data: string): boolean {
          if (cleaned) return false;
          const ok = reply.raw.write(data);
          backpressure = ok ? 0 : backpressure + 1;
          if (backpressure > 200) shouldClose = true;
          return ok;
        }

        // 函数声明（hoisted）：补发阶段同步超阈值时只置 shouldClose，待 subscribe 返回后再统一清理
        function cleanup(): void {
          if (cleaned) return; // 幂等：自然断开与 closeAll 可能重复触发
          cleaned = true;
          clearInterval(heartbeat);
          unsubscribe();
          unregisterClose(); // 注销 close handler，避免 event bus 残留闭包
          const c = sseConnections.get(subjectHash) ?? 1;
          if (c <= 1) sseConnections.delete(subjectHash);
          else sseConnections.set(subjectHash, c - 1);
        }

        function maybeClose(): void {
          if (shouldClose && !cleaned) {
            cleanup();
            reply.raw.end();
          }
        }

        const heartbeat = setInterval(() => {
          writeRaw(": ping\n\n");
          maybeClose();
        }, 15000);

        let subscribed = false;
        unsubscribe = events.subscribe(({ id, event }) => {
          if (shouldClose || cleaned) return;
          writeRaw(formatSseEvent(id, event));
          // 仅实时阶段（unsubscribe 已赋值）才 maybeClose；补发阶段只置 shouldClose
          if (subscribed) maybeClose();
        }, effectiveLastEventId);
        subscribed = true;

        // 补发阶段（subscribe 内同步）可能已超阈值：此时 unsubscribe 刚赋值，统一清理
        maybeClose();
        if (cleaned) return; // 补发阶段已断开：不注册 close handler，避免残留闭包

        request.raw.on("close", cleanup);
        // 删除会话/关闭时由 event bus closeAll 终止本连接
        unregisterClose = events.registerClose(() => {
          cleanup();
          reply.raw.end();
        });
      });
    },
    { prefix: "/v1" },
  );

  // 优雅关闭：停止接收新请求后，等在途任务完成或超时，超时则中止（README §7）
  const SHUTDOWN_GRACE_MS = 30_000;
  app.addHook("onClose", async () => {
    // 先关闭所有 SSE 长连接，避免 app.close 无限等待
    registry.closeAllEvents();
    // 等在途任务完成或超时
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (concurrency.activeCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 中止并释放所有 runtime（idle runtime 也 dispose，释放 adapter/订阅）
    await registry.abortAll();
    registry.dispose();
  });

  return app;
}