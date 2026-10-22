// HTTP composition root: Fastify concerns (authentication, validation, response mapping, SSE, CORS and shutdown)
// remain here; session/project application behavior is implemented by SessionService.

import { randomUUID, createHash } from "node:crypto";
import type { Writable } from "node:stream";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import { identityKey, type UserIdentity } from "../core/user-identity.js";
import type { IpAccessResolveInput } from "../core/ip-access-policy.js";
import { ConcurrencyController } from "../core/concurrency-control.js";
import type { AgentAdapter } from "../agent/agent-adapter.js";
import {
  IMAGE_INPUT_LIMITS,
  IMAGE_INPUT_REJECTION_MESSAGES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  normalizeImageInputs,
} from "../agent/image-input.js";
import { TURN_TEXT_LIMITS, checkTurnText } from "../core/text-input.js";
import { DEFAULT_PROJECT_ID } from "../application/ports/index.js";
import type {
  IdempotencyStorePort,
  ModelCatalogPort,
  ModelDescriptor,
  ObservabilityPort,
  ProjectStorePort,
  ConversationStorageRegistry,
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
  ROUTE_PERMISSIONS,
  projectAccessCapabilities,
  requirePermission,
  routeRbacOnRequest,
} from "./route-rbac.js";
import { formatSseEvent } from "./sse-format.js";
import { nextBackpressureState, SSE_BACKPRESSURE_THRESHOLD } from "./sse-backpressure.js";
import { defaultSseSocket, type SseReplyRaw, type SseRequestRaw, type SseSocket } from "./sse-socket.js";
import { FilePreviewError, previewProjectFile } from "./session-file-preview.js";
import { FileSearchError, createProjectFileSearch } from "./session-file-search.js";
import { BUILTIN_SESSION_COMMANDS } from "./session-resources.js";
import { ATTACHMENT_MAX_BYTES } from "../attachments/file-policy.js";
import { UploadService } from "../application/upload-service.js";
import { CompanionGreetingError, type CompanionGreeter } from "../application/companion-greeter.js";
import { applySharedMcpForm, SharedMcpConfigError, sharedMcpList, validateSharedMcpEntry } from "../mcp/shared-config.js";
import { AgentSettingsError } from "../settings/agent-settings-file.js";
import { AGENT_THINKING_LEVELS, MAX_AGENT_RETRIES, type AgentSettingsInput } from "../shared/agent-settings.js";
import type { SharedMcpServerInput } from "../shared/shared-mcp.js";
import { ProviderLoginError, type ProviderLogins } from "../model-adapters/pi-provider-logins.js";
import type { ProviderLoginAnswer, ProviderLoginStart } from "../shared/provider-auth.js";
import { mcpServerIdentity, projectMcpServerViews, validateProjectMcpSetting, type ProjectMcpServerView, type ProjectMcpSettingInput } from "../mcp/project-settings.js";

export type ServerDeps = {
  sessions: SessionStorePort;
  /**
   * WP5D-2 网络准入配置（严格必填，无默认）：app 全局 onRequest admission 唯一数据源。
   * 运行时做严格 shape 校验（requireIpAccessRuntimeConfig）：缺失/伪造/字段非法一律 failfast——
   * 直接 JS bypass 同样被拒。
   */
  ipAccess: IpAccessResolveInput;
  projects: ProjectStorePort;
  /** Optional only for custom test hosts; production injects a configured upload service. */
  uploads?: UploadService;
  defaultProjectCwd: string;
  defaultProjectName?: string;
  modelCatalog?: ModelCatalogPort;
  defaultModel?: ModelDescriptor | null;
  defaultThinkingLevel?: string;
  /** 通用 runtime adapter 工厂；生产组合由 SessionConversationCoordinator 提供。 */
  createAdapter: (sessionId: string) => Promise<AgentAdapter>;
  /** `/` 菜单里的提示词模板与 skills（按会话项目 cwd 发现）；缺省时只列内置命令。 */
  listSessionCommands?: (projectCwd: string) => Promise<import("../shared/commands.js").SessionCommandInfo[]>;
  /** Writes the blank-session companion's opening line; absent when no default model is configured. */
  companionGreeter?: Pick<CompanionGreeter, "greet">;
  /** Short titles for untitled sessions from their first prompt; absent = the list shows the prompt. */
  sessionTitler?: { title(prompt: string): Promise<string | null> };
  /** Keeps the companion's persona per caller; without it the page keeps the persona per browser. */
  companionPersonas?: import("../application/ports/companion-persona-store-port.js").CompanionPersonaStorePort;
  /** MCP 目录与项目设置；缺省时项目 MCP 接口返回未配置（测试用）。 */
  projectMcp?: {
    readonly catalog: import("../mcp/catalog.js").McpCatalog;
    /** 项目自己的目录（加上信任项目的 .pi/mcp.json）；缺省时所有项目都用 `catalog`。 */
    readonly projectCatalogs?: Pick<import("../mcp/project-config.js").ProjectMcpCatalogs, "forProject">;
    readonly store: import("../application/ports/project-mcp-store-port.js").ProjectMcpStorePort;
  };
  /** 共享 MCP，即 Pi 的全局 mcp.json（docs/mcp-integration.md §14.3）：所有人能看列表，admin 能增删改。 */
  sharedMcp?: {
    readonly file: import("../mcp/shared-config.js").SharedMcpConfigFile;
    readonly catalog: import("../mcp/live-catalog.js").LiveMcpCatalog;
  };
  /** Agent 设置，即 Pi 全局 settings.json 里的几个字段：所有人能看，admin 能改。缺省时相关接口返回未配置。 */
  agentSettings?: Pick<import("../settings/agent-settings-file.js").AgentSettingsFile, "values" | "view" | "update" | "modelThinkingLevelsFor">;
  /** 项目信任，即 Pi 的 trust.json：所有人能看，admin 能改。缺省时相关接口返回未配置。 */
  projectTrust?: Pick<import("../settings/project-trust.js").ProjectTrust, "status" | "set">;
  /** 按用户 MCP OAuth（docs/mcp-integration.md §13）；目录里没有 oauth server 时缺省。 */
  mcpOAuth?: Pick<import("../mcp/oauth-connections.js").McpOAuthConnections, "list" | "start" | "complete" | "disconnect" | "returnUrl">;
  /** 模型登录（Pi 的 auth.json，对应 TUI 的 /login、/logout）；缺省时相关接口返回未配置。 */
  providerLogins?: Pick<ProviderLogins, "list" | "start" | "get" | "answer" | "cancel" | "logout">;
  /** 生产组合根注入的通用会话存储 registry；用于未实例化会话的只读导出。 */
  conversationStorage?: ConversationStorageRegistry;
  nativeSessions?: import("../application/ports/native-session-port.js").NativeSessionPort;
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
  /** 组装完成的 SessionService 回调；供同进程受信插件宿主复用既有 owner/runtime 语义。 */
  onSessionServiceReady?: (service: SessionService) => void;
  /** 宿主 runtime 停止并释放后执行；用于插件与存储的关闭顺序编排。 */
  onRuntimeClosed?: () => Promise<void>;
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
    // requestId/prompt 的长度上限由 core/text-input.ts 的 TURN_TEXT_LIMITS 派生（与插件
    // runTurn 同一权威值）；schema 只作预检，业务侧仍会重校并给出固定错误文案。
    requestId: { type: "string", maxLength: TURN_TEXT_LIMITS.maxRequestIdLength },
    prompt: { type: "string", maxLength: TURN_TEXT_LIMITS.maxPromptLength },
    parentId: { type: "string" },
    fileIds: { type: "array", maxItems: 5, items: { type: "string", minLength: 1, maxLength: 64 } },
    images: {
      type: "array",
      maxItems: IMAGE_INPUT_LIMITS.maxImages,
      items: {
        type: "object",
        properties: {
          mediaType: { type: "string", enum: [...SUPPORTED_IMAGE_MEDIA_TYPES] },
          base64: { type: "string", maxLength: IMAGE_INPUT_LIMITS.maxImageBase64Length },
        },
        required: ["mediaType", "base64"],
        additionalProperties: false,
      },
    },
  },
  required: ["requestId", "prompt"],
  additionalProperties: false,
} as const;
const STEERING_BODY_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", maxLength: TURN_TEXT_LIMITS.maxPromptLength },
    controlId: { type: "string", minLength: 1, maxLength: 128 },
    acknowledgementId: { type: "string", minLength: 1, maxLength: 128 },
    requestId: MESSAGES_BODY_SCHEMA.properties.requestId,
    images: MESSAGES_BODY_SCHEMA.properties.images },
  required: ["text"], additionalProperties: false,
  anyOf: [{ required: ["controlId", "acknowledgementId", "requestId"] },
    { not: { anyOf: [{ required: ["controlId"] }, { required: ["acknowledgementId"] }, { required: ["requestId"] }, { required: ["images"] }] } }],
} as const;
const SUBAGENT_STEER_BODY_SCHEMA = {
  type: "object", properties: { text: { type: "string", maxLength: TURN_TEXT_LIMITS.maxPromptLength } },
  required: ["text"], additionalProperties: false,
} as const;
const SUBAGENT_STEER_CONFLICTS = {
  "not-found": { code: "SUBAGENT_NOT_RUNNING", message: "子代理未在运行，无法引导" },
  "not-running": { code: "SUBAGENT_NOT_RUNNING", message: "子代理未在运行，无法引导" },
  "no-channel": { code: "SUBAGENT_STEER_UNAVAILABLE", message: "该子代理没有可用的引导通道" },
  failed: { code: "SUBAGENT_STEER_FAILED", message: "引导发送失败，请稍后重试" },
} as const;
type CompanionGreetingBody = import("../shared/companion.js").CompanionGreetingInput;
const COMPANION_GREETING_BODY_SCHEMA = {
  type: "object",
  properties: {
    persona: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 12 }, style: { type: "string", enum: ["concise", "lively", "formal"] } },
      required: ["name", "style"], additionalProperties: false,
    },
    dayPart: { type: "string", enum: ["dawn", "morning", "noon", "afternoon", "evening", "night"] },
    recent: {
      type: ["object", "null"],
      properties: { title: { type: "string", maxLength: 200 }, minutesAgo: { type: "integer", minimum: 0 } },
      required: ["title", "minutesAgo"], additionalProperties: false,
    },
  },
  required: ["persona", "dayPart"], additionalProperties: false,
} as const;
const COMPANION_PERSONA_BODY_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 12, pattern: "\\S" },
    style: COMPANION_GREETING_BODY_SCHEMA.properties.persona.properties.style,
    docked: { type: "boolean" },
  },
  required: ["name", "style", "docked"], additionalProperties: false,
} as const;
const PROJECT_MCP_SERVER_BODY_SCHEMA = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    exposure: { anyOf: [{ type: "string", enum: ["direct", "codemode", "deferred", "hidden"] }, { type: "null" }] },
    hiddenTools: { type: "array", maxItems: 256, items: { type: "string", minLength: 1, maxLength: 128, pattern: "^[^*\\s]+$" } },
  },
  required: ["enabled"], additionalProperties: false,
} as const;
const MCP_EXPOSURE_SCHEMA = { type: "string", enum: ["direct", "codemode", "deferred", "hidden"] } as const;
const STRING_MAP_SCHEMA = { type: "object", maxProperties: 64, additionalProperties: { type: "string", maxLength: 8192 } } as const;
const PROVIDER_LOGIN_START_BODY_SCHEMA = {
  type: "object",
  required: ["provider", "method"],
  properties: { provider: { type: "string", minLength: 1, maxLength: 200 }, method: { enum: ["oauth", "api_key"] } },
  additionalProperties: false,
} as const;
const PROVIDER_LOGIN_ANSWER_BODY_SCHEMA = {
  type: "object",
  required: ["promptId", "value"],
  properties: { promptId: { type: "string", minLength: 1, maxLength: 64 }, value: { type: "string", maxLength: 16384 } },
  additionalProperties: false,
} as const;

const SHARED_MCP_SERVER_BODY_SCHEMA = {
  type: "object",
  properties: {
    hash: { type: "string", minLength: 1, maxLength: 128 },
    server: {
      type: "object",
      properties: {
        transport: { type: "string", enum: ["http", "stdio"] },
        url: { type: "string", maxLength: 2048 },
        headers: STRING_MAP_SCHEMA,
        command: { type: "string", maxLength: 4096 },
        args: { type: "array", maxItems: 256, items: { type: "string", maxLength: 8192 } },
        env: STRING_MAP_SCHEMA,
        cwd: { type: "string", maxLength: 4096 },
        description: { type: "string", maxLength: 4000 },
        exposure: MCP_EXPOSURE_SCHEMA,
        maxExposure: MCP_EXPOSURE_SCHEMA,
        adminOnly: { type: "boolean" },
        defaultEnabled: { type: "boolean" },
        timeout: { type: "number", exclusiveMinimum: 0, maximum: 86400 },
        enabled: { type: "boolean" },
        oauth: { anyOf: [{ type: "object", properties: { scope: { type: "string", maxLength: 1000 } }, additionalProperties: false }, { type: "null" }] },
      },
      required: ["transport"], additionalProperties: false,
    },
  },
  required: ["hash", "server"], additionalProperties: false,
} as const;
const PROJECT_TRUST_BODY_SCHEMA = {
  type: "object",
  required: ["trusted"],
  properties: { trusted: { type: "boolean" } },
  additionalProperties: false,
} as const;

/** GET /models 与 /settings 的可选项目：按这个项目（受信任时）的 .pi/settings.json 给出实际生效的值。 */
const PROJECT_QUERY_SCHEMA = {
  type: "object",
  properties: { projectId: { type: "string", minLength: 1, maxLength: 128 } },
  additionalProperties: false,
} as const;

const AGENT_SETTINGS_BODY_SCHEMA = {
  type: "object",
  properties: {
    hash: { type: "string", minLength: 1, maxLength: 128 },
    values: {
      type: "object",
      properties: {
        autoCompaction: { type: "boolean" },
        autoRetry: { type: "boolean" },
        maxRetries: { type: "integer", minimum: 0, maximum: MAX_AGENT_RETRIES },
        modelThinkingLevels: {
          type: "object", maxProperties: 500,
          propertyNames: { minLength: 3, maxLength: 256 },
          additionalProperties: { type: "string", enum: AGENT_THINKING_LEVELS },
        },
      },
      additionalProperties: false,
    },
  },
  required: ["hash", "values"], additionalProperties: false,
} as const;
const SESSION_COMMAND_BODY_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["compact", "reload", "extension"] }, args: { type: "string", maxLength: 4000 },
    name: { type: "string", minLength: 1, maxLength: 128, pattern: "^[^\\s/]+$" },
  },
  required: ["command"], additionalProperties: false,
} as const;
const COMMAND_PROMPT_ANSWER_BODY_SCHEMA = {
  type: "object",
  properties: {
    promptId: { type: "string", minLength: 1, maxLength: 64 }, cancel: { type: "boolean" },
    value: { type: "string", maxLength: 65536 }, confirmed: { type: "boolean" },
  },
  required: ["promptId"], additionalProperties: false,
} as const;
const CONTROL_MUTATION_BODY_SCHEMA = {
  type: "object",
  properties: { requestId: { type: "string", minLength: 1, maxLength: 128 },
    acknowledgementId: STEERING_BODY_SCHEMA.properties.acknowledgementId },
  required: ["requestId", "acknowledgementId"], additionalProperties: false,
} as const;
/**
 * Abort body is optional. JSON Schema cannot express an absent (`undefined`) body alongside a
 * strict object, so validate the supplied body here and leave an absent one untouched.
 */
function parseAbortBody(body: unknown):
  | { ok: true; supplied: false }
  | { ok: true; supplied: true; expectedRequestId: unknown }
  | { ok: false } {
  if (body === undefined) return { ok: true, supplied: false };
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "requestId") return { ok: false };
  return { ok: true, supplied: true, expectedRequestId: record.requestId };
}
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
    createRequestId: { type: "string", minLength: 1, maxLength: 128 },
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
const CONFLICT = (reply: FastifyReply, code?: "MODEL_FAILBACK_IN_PROGRESS") =>
  reply.code(409).send({
    statusCode: 409,
    error: "Conflict",
    ...(code ? { code } : {}),
    message: code ? "模型切换接续中，暂不能取消" : "会话无活动任务或状态不允许",
  });

/** adminOnly server 只有 admin 能启用；没有编辑权或 server 已从目录删除时都不能启用。 */
function withEnableCapability(views: readonly ProjectMcpServerView[], canEdit: boolean, isAdmin: boolean): ProjectMcpServerView[] {
  return views.map(view => ({ ...view, canEnable: canEdit && view.status === "available" && (!view.adminOnly || isAdmin) }));
}

function hashIdentity(identity: UserIdentity): string {
  return createHash("sha256").update(identityKey(identity)).digest("hex").slice(0, 16);
}

/** Opaque, owner-scoped UUID for an opt-in creation retry key; clients cannot choose a session ID. */
function creationSessionId(ownerKey: string, key: string): string {
  const bytes = createHash("sha256").update("pi-session-create-v1\0").update(ownerKey).update("\0").update(key).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

import { abortTrace, installAbortTrace, withAbortTrace } from "../core/abort-trace.js";

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
  // A single raw, bounded file per request; no multipart parser or new dependency.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: ATTACHMENT_MAX_BYTES },
    (_request, body, done) => done(null, body));
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
  const searchProjectFiles = createProjectFileSearch();
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
    conversationStorage: deps.conversationStorage,
    nativeSessions: deps.nativeSessions,
    uploads: deps.uploads,
    idempotencyRepo: deps.idempotencyRepo,
    sessionTitler: deps.sessionTitler,
    createId: randomUUID,
    now: Date.now,
  });
  deps.onSessionServiceReady?.(sessions);

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
  // - 身份默认 = 直接 socket IP（canonical，IPv4-mapped 归一 v4）；仅当 TCP 对端为回环（同机
  //   代理）时才采用 X-Forwarded-For 最右条目（nginx 追加语义的正确解析），其余情况忽略 XFF；
  //   request.ip 一律不用（受 trustProxy 影响）；
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
    // P7b 宿主访问能力投影：最小固定响应体 `{canRead, canWrite}`，由中央 ROUTE_PERMISSIONS
    // 矩阵 + evaluateRouteAuthorization 派生（绝不返回 role/IP/token）。纯读 GET，与其它只读
    // 路由同为 viewer/user/admin；operator 仍由全局 default-deny 403 拒。
    // 响应依赖调用方身份（当前仅来自来源 IP）：不得被共享缓存，否则 admin 的
    // {canWrite:true} 可能回给其他来源（仅 Vary: Authorization 不够）。
    api.get("/access", { ...requirePermission("access:read") }, async (request, reply) =>
      reply.header("cache-control", "private, no-store").send(projectAccessCapabilities(request.access.role)),
    );
    /** 查询参数里的项目：没给时为 undefined，调用者看不到时为 null。 */
    const queriedProjectCwd = async (request: FastifyRequest<{ Querystring: { projectId?: string } }>): Promise<string | null | undefined> => {
      const projectId = request.query.projectId;
      if (projectId === undefined) return undefined;
      return (await sessions.projectCwd(ownerKeyOf(request), projectId))?.cwd ?? null;
    };
    // 给了项目时，按模型的思考档位叠加这个项目（受信任时）的 .pi/settings.json，和该项目的新会话实际用的一致。
    api.get<{ Querystring: { projectId?: string } }>("/models", { schema: { querystring: PROJECT_QUERY_SCHEMA }, ...requirePermission("models:list") }, async (request, reply) => {
      const projectCwd = await queriedProjectCwd(request);
      if (projectCwd === null) return NOT_FOUND(reply);
      const settings = deps.agentSettings;
      const modelThinkingLevels = settings ? (projectCwd ? settings.modelThinkingLevelsFor(projectCwd) : settings.values.modelThinkingLevels) : {};
      return { ...await sessions.models(), modelThinkingLevels };
    });
    api.get("/projects", { ...requirePermission("projects:list") }, async (request) =>
      (await sessions.listProjects(ownerKeyOf(request))).map(project => ({ ...project,
        canCreateSession: project.canCreateSession !== false && ROUTE_PERMISSIONS["sessions:create"].includes(request.access.role),
      })));
    api.post<{ Body: Buffer }>("/files", { ...requirePermission("files:upload"), bodyLimit: ATTACHMENT_MAX_BYTES }, async (request, reply) => {
      if (!deps.uploads) return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", message: "文件上传尚未配置" });
      const header = (key: string): string | null => {
        const value = request.headers[key];
        return typeof value === "string" ? value : null;
      };
      let name: string;
      try { name = decodeURIComponent(header("x-upload-name") ?? ""); }
      catch { return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "文件名非法" }); }
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "仅接受二进制原文件" });
      const result = await deps.uploads.upload({
        ownerKey: ownerKeyOf(request), projectId: header("x-upload-project-id") ?? "",
        uploadKey: header("x-upload-key") ?? "", originalName: name,
        declaredMediaType: header("x-upload-type") ?? "application/octet-stream",
        kind: header("x-upload-kind") ?? "", bytes: request.body,
      });
      if (result.kind === "ready") {
        const file = result.file;
        return reply.code(201).send({ fileId: file.fileId, name: file.name, mediaType: file.mediaType,
          size: file.size, status: file.status, agentPath: file.agentPath });
      }
      const status = result.kind === "not-found" ? 404 : result.kind === "invalid" ? 400 :
        result.kind === "conflict" ? 409 : result.kind === "quota" ? 507 : 503;
      return reply.code(status).send({ statusCode: status, error: "Upload Failed", message: result.message });
    });
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

    api.post<{ Body: { createRequestId?: string; title?: string; projectId?: string; modelProvider?: string; modelId?: string; thinkingLevel?: string } }>(
      "/sessions",
      { schema: { body: SESSIONS_BODY_SCHEMA }, ...requirePermission("sessions:create") },
      async (request, reply) => {
        const { createRequestId, ...input } = request.body;
        const owner = ownerKeyOf(request);
        const sessionId = createRequestId === undefined ? undefined : creationSessionId(owner, createRequestId);
        const sameRequest = (session: { projectId: string; title: string; modelProvider: string | null; modelId: string | null; thinkingLevel: string | null }) =>
          session.projectId === (input.projectId ?? DEFAULT_PROJECT_ID) &&
          session.title === (input.title ?? "") &&
          session.modelProvider === (input.modelProvider ?? null) &&
          session.modelId === (input.modelId ?? null) &&
          session.thinkingLevel === (input.thinkingLevel ?? null);
        if (sessionId) {
          const previous = await sessions.getSession(owner, sessionId);
          if (previous) return sameRequest(previous)
            ? reply.code(200).send(previous)
            : reply.code(409).send({ statusCode: 409, error: "Conflict", message: "同一 createRequestId 不能用于不同配置" });
        }
        const result = await sessions.createSession(owner, sessionId ? { ...input, sessionId } : input);
        if (result.kind === "id-conflict" && sessionId) {
          const previous = await sessions.getSession(owner, sessionId);
          if (previous && sameRequest(previous)) return reply.code(200).send(previous);
        }
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
          case "id-conflict":
            // 预留/指定 sessionId 仅宿主插件预约使用；HTTP 层不接受 sessionId，此分支理论不可达。
            return reply.code(500).send({ statusCode: 500, error: "Internal Server Error", message: "会话 ID 冲突" });
        }
      },
    );
    api.get<{ Querystring: { projectId?: string } }>("/sessions", { ...requirePermission("sessions:list") }, async (request, reply) =>
      sessions.listSessions(ownerKeyOf(request), request.query.projectId, warnings => {
        // Fixed, bounded codes only: never paths, header values or transcript content.
        const allowed = ["native-source-unavailable", "native-source-skipped", "native-scan-truncated"];
        const safe = allowed.filter(code => warnings.includes(code));
        if (safe.length) reply.header("X-Pi-Native-Scan-Warnings", safe.join(","));
      }));
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
    api.post<{ Params: { id: string }; Body: { requestId: string; prompt: string; parentId?: string; fileIds?: string[]; images?: { mediaType: string; base64: string }[] } }>(
      "/sessions/:id/messages",
      { schema: { body: MESSAGES_BODY_SCHEMA }, ...requirePermission("sessions:send-message") },
      async (request, reply) => {
        // 业务验证纪律：schema 只是预算（maxLength/maxItems/enum），下面是权威校验，发生在
        // 进入 session service / runtime / SDK **之前**。任何失败都是固定文案 400，绝不回显内容。
        const requestIdCheck = checkTurnText(request.body.requestId, TURN_TEXT_LIMITS.maxRequestIdLength);
        if (!requestIdCheck.ok) {
          return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "requestId 非法" });
        }
        const images = normalizeImageInputs(request.body.images);
        if (!images.ok) {
          return reply
            .code(400)
            .send({ statusCode: 400, error: "Bad Request", message: IMAGE_INPUT_REJECTION_MESSAGES[images.reason] });
        }
        // 仅图片消息是公开会话通道的合法输入：至少一张图片通过权威校验时允许空 prompt；
        // 无图消息和插件 runTurn 仍必须包含非空文本。
        const promptCheck = checkTurnText(request.body.prompt, TURN_TEXT_LIMITS.maxPromptLength, {
          allowEmpty: images.images.length > 0 || (request.body.fileIds?.length ?? 0) > 0,
        });
        if (!promptCheck.ok) {
          return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "prompt 非法" });
        }
        const result = await sessions.submitMessage(ownerKeyOf(request), request.params.id, {
          ...request.body,
          images: images.images.length > 0 ? [...images.images] : undefined,
        });
        if (!result.found) return NOT_FOUND(reply);
        if ("fileError" in result) {
          const status = result.fileError === "invalid" ? 400 : result.fileError === "not-found" ? 404 :
            result.fileError === "conflict" ? 409 : 503;
          return reply.code(status).send({ statusCode: status, error: "File Rejected", message: result.message });
        }
        switch (result.decision.kind) {
          case "run": return reply.code(202).send({ status: "accepted" });
          case "queued": return reply.code(202).send({ status: "queued", position: result.decision.position });
          case "rejected": return reply.code(429).send({ statusCode: 429, error: "Too Many Requests", message: result.decision.reason === "user-queue-full" ? "用户队列已满" : "服务过载，请稍后重试" });
          case "conflict": return reply.code(409).send({ statusCode: 409, error: "Conflict",
            ...(result.decision.reason === "idempotency-unknown" ? { code: "REQUEST_STATUS_UNKNOWN" } : {}),
            message: result.decision.reason === "poisoned" ? "会话任务异常，请新建会话" :
              result.decision.reason === "payload-mismatch" ? "同一 requestId 不能用于不同内容" :
              result.decision.reason === "idempotency-unknown" ? "原请求已登记但执行结果未确认，请先核对历史，不得自动重发" : "会话已有活动任务" });
          case "done": return reply.code(200).send(result.decision.result);
        }
      },
    );
    api.get<{ Params: { id: string } }>("/sessions/:id/export", { ...requirePermission("sessions:export") }, async (request, reply) => {
      const exported = await sessions.exportSession(ownerKeyOf(request), request.params.id);
      return exported ? reply.code(200).send(exported) : NOT_FOUND(reply);
    });
    api.get<{ Params: { id: string }; Querystring: { runId?: string } }>("/sessions/:id/subagents", { ...requirePermission("sessions:export") }, async (request, reply) => {
      const runId = typeof request.query.runId === "string" ? request.query.runId : undefined;
      const snapshot = await sessions.getSubagents(ownerKeyOf(request), request.params.id, runId);
      return snapshot ? reply.code(200).send(snapshot) : NOT_FOUND(reply);
    });
    // A person's steer for a running child. 202 means the child's control channel took it;
    // delivery shows in the subagent transcript once the child starts that turn.
    api.post<{ Params: { id: string; runId: string }; Body: { text: string } }>("/sessions/:id/subagents/:runId/steer",
      { schema: { body: SUBAGENT_STEER_BODY_SCHEMA, params: { type: "object", required: ["id", "runId"],
        properties: { id: { type: "string" }, runId: { type: "string", minLength: 1, maxLength: 128 } } } }, ...requirePermission("sessions:control") },
      async (request, reply) => {
        const text = checkTurnText(request.body.text, TURN_TEXT_LIMITS.maxPromptLength);
        if (!text.ok) return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "text 非法" });
        const result = await sessions.steerSubagent(ownerKeyOf(request), request.params.id, request.params.runId, text.value);
        if (result === "not-found") return NOT_FOUND(reply);
        if (result !== "unavailable" && result.ok) return reply.code(202).send();
        const reason = result === "unavailable" ? "no-channel" : result.reason;
        if (reason === "invalid") return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "text 非法" });
        return reply.code(409).send({ statusCode: 409, error: "Conflict", ...SUBAGENT_STEER_CONFLICTS[reason] });
      });
    api.get<{ Params: { id: string } }>("/sessions/:id/steps", { ...requirePermission("sessions:export") }, async (request, reply) => {
      const snapshot = await sessions.getSessionSteps(ownerKeyOf(request), request.params.id);
      return snapshot ? reply.code(200).send(snapshot) : NOT_FOUND(reply);
    });
    api.get<{ Params: { id: string } }>("/sessions/:id/system-prompt", { ...requirePermission("sessions:export") }, async (request, reply) => {
      const snapshot = await sessions.getSystemPromptSnapshot(ownerKeyOf(request), request.params.id);
      return snapshot ? reply.code(200).send(snapshot) : NOT_FOUND(reply);
    });
    // A session-owned, read-only project preview. Its root is resolved only from the owned
    // session's project record; there is deliberately no root/cwd parameter in this public API.
    api.get<{ Params: { id: string }; Querystring: { path?: unknown; line?: unknown } }>(
      "/sessions/:id/file-preview",
      { exposeHeadRoute: false, ...requirePermission("sessions:file-preview") },
      async (request, reply) => {
        const projectCwd = await sessions.sessionProjectCwd(ownerKeyOf(request), request.params.id);
        if (!projectCwd) return NOT_FOUND(reply);
        try {
          return reply.code(200).send(previewProjectFile(projectCwd, request.query.path, request.query.line));
        } catch (error) {
          if (error instanceof FilePreviewError) {
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: error.code, message: "文件预览请求不可用" });
          }
          throw error;
        }
      },
    );
    // Path names only (never contents) for `@` references; same session-owned root as preview.
    // The project variants serve the blank composer before its session exists.
    type RootOf = (ownerKey: string, id: string) => Promise<{ cwd: string; dev: number; ino: number } | null>;
    const fileSearchRoute = (rootOf: RootOf) => async (request: FastifyRequest<{ Params: { id: string }; Querystring: { query?: unknown } }>, reply: FastifyReply) => {
      const projectCwd = await rootOf(ownerKeyOf(request), request.params.id);
      if (!projectCwd) return NOT_FOUND(reply);
      try {
        return reply.code(200).send(await searchProjectFiles(projectCwd, request.query.query));
      } catch (error) {
        if (error instanceof FileSearchError) {
          return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: error.code, message: "文件搜索请求不可用" });
        }
        throw error;
      }
    };
    const commandListRoute = (rootOf: RootOf, includeBuiltins: boolean) => async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const projectCwd = await rootOf(ownerKeyOf(request), request.params.id);
      if (!projectCwd) return NOT_FOUND(reply);
      const commands = deps.listSessionCommands ? await deps.listSessionCommands(projectCwd.cwd) : [...BUILTIN_SESSION_COMMANDS];
      // Host and extension commands act on a live session; a draft only gets templates and skills.
      return reply.code(200).send({ commands: includeBuiltins ? commands : commands.filter(command => command.source !== "builtin" && command.source !== "extension") });
    };
    const sessionRoot: RootOf = (owner, id) => sessions.sessionProjectCwd(owner, id);
    const projectRoot: RootOf = (owner, id) => sessions.projectCwd(owner, id);
    api.get<{ Params: { id: string }; Querystring: { query?: unknown } }>("/sessions/:id/files",
      { exposeHeadRoute: false, ...requirePermission("sessions:file-preview") }, fileSearchRoute(sessionRoot));
    api.get<{ Params: { id: string } }>("/sessions/:id/commands",
      { exposeHeadRoute: false, ...requirePermission("sessions:export") }, commandListRoute(sessionRoot, true));
    api.get<{ Params: { id: string }; Querystring: { query?: unknown } }>("/projects/:id/files",
      { exposeHeadRoute: false, ...requirePermission("sessions:create") }, fileSearchRoute(projectRoot));
    api.get<{ Params: { id: string } }>("/projects/:id/commands",
      { exposeHeadRoute: false, ...requirePermission("sessions:create") }, commandListRoute(projectRoot, false));
    // The blank-session companion's opening line. Only the caller's own facts reach the model;
    // any failure is a 503 the page answers with its local lines.
    api.post<{ Params: { id: string }; Body: CompanionGreetingBody }>("/projects/:id/companion/greeting",
      { schema: { body: COMPANION_GREETING_BODY_SCHEMA }, ...requirePermission("sessions:create") },
      async (request, reply) => {
        const ownerKey = ownerKeyOf(request);
        const projectName = await sessions.projectName(ownerKey, request.params.id);
        const root = projectName === null ? null : await sessions.projectCwd(ownerKey, request.params.id);
        if (projectName === null || !root) return NOT_FOUND(reply);
        const unavailable = () => reply.code(503).send({ statusCode: 503, error: "Service Unavailable", code: "companion_unavailable", message: "开场白暂不可用" });
        if (!deps.companionGreeter) return unavailable();
        const commands = deps.listSessionCommands ? (await deps.listSessionCommands(root.cwd)).filter(command => command.source === "prompt" || command.source === "skill") : [];
        const { persona, dayPart, recent } = request.body;
        try {
          return reply.code(200).send(await deps.companionGreeter.greet({
            ownerKey, projectId: request.params.id, projectName, persona, dayPart, recent: recent ?? null,
            commands: commands.map(command => ({ name: command.name, ...(command.description ? { description: command.description } : {}) })),
          }));
        } catch (error) {
          if (!(error instanceof CompanionGreetingError)) request.log.warn({ err: error }, "companion greeting failed");
          return unavailable();
        }
      });
    // 项目 MCP 设置（docs/mcp-integration.md §4.4）：项目可见者可读；owner 可启用与收紧，
    // adminOnly server 与共享的默认项目只有 admin 能改。修改只影响之后创建或恢复的会话。
    // 项目的目录：信任的项目还有它 .pi/mcp.json 里的 server。看不到项目时为 null。
    const projectMcpCatalog = async (ownerKey: string, projectId: string, projectMcp: NonNullable<ServerDeps["projectMcp"]>) => {
      if ((await sessions.projectName(ownerKey, projectId)) === null) return null;
      if (!projectMcp.projectCatalogs) return { catalog: { servers: projectMcp.catalog.servers } };
      const root = await sessions.projectCwd(ownerKey, projectId);
      return root ? projectMcp.projectCatalogs.forProject(root.cwd) : null;
    };
    api.get<{ Params: { id: string } }>("/projects/:id/mcp", { exposeHeadRoute: false, ...requirePermission("projects:mcp-read") },
      async (request, reply) => {
        if (!deps.projectMcp) {
          if ((await sessions.projectName(ownerKeyOf(request), request.params.id)) === null) return NOT_FOUND(reply);
          return { configured: false, canEdit: false, servers: [] };
        }
        const project = await projectMcpCatalog(ownerKeyOf(request), request.params.id, deps.projectMcp);
        if (!project) return NOT_FOUND(reply);
        const settings = await deps.projectMcp.store.list(request.params.id);
        const canEdit = ROUTE_PERMISSIONS["projects:mcp-write"].includes(request.access.role) &&
          (request.params.id !== DEFAULT_PROJECT_ID || request.access.role === "admin");
        const servers = withEnableCapability(projectMcpServerViews(project.catalog, settings), canEdit, request.access.role === "admin");
        return { configured: true, canEdit, servers, ...(project.status ? { projectConfig: project.status } : {}) };
      });
    api.put<{ Params: { id: string; name: string }; Body: ProjectMcpSettingInput }>("/projects/:id/mcp/servers/:name",
      { schema: { body: PROJECT_MCP_SERVER_BODY_SCHEMA }, ...requirePermission("projects:mcp-write") },
      async (request, reply) => {
        const ownerKey = ownerKeyOf(request);
        const { id, name } = request.params;
        if (!deps.projectMcp) {
          if ((await sessions.projectName(ownerKey, id)) === null) return NOT_FOUND(reply);
          return reply.code(404).send({ statusCode: 404, error: "Not Found", code: "mcp_not_configured", message: "服务未配置 MCP 目录" });
        }
        // 校验和记下身份用同一份内容，期间 mcp.json 被改也对得上。
        const project = await projectMcpCatalog(ownerKey, id, deps.projectMcp);
        if (!project) return NOT_FOUND(reply);
        const isAdmin = request.access.role === "admin";
        if (id === DEFAULT_PROJECT_ID && !isAdmin) {
          return reply.code(403).send({ statusCode: 403, error: "Forbidden", code: "mcp_default_project", message: "默认项目由所有用户共享，只有管理员能修改其 MCP 设置" });
        }
        const catalog = project.catalog;
        const error = validateProjectMcpSetting(catalog, name, request.body, isAdmin);
        if (error?.code === "unknown_server") return reply.code(404).send({ statusCode: 404, error: "Not Found", code: "mcp_unknown_server", message: "目录中没有这个 MCP server" });
        if (error?.code === "admin_only") return reply.code(403).send({ statusCode: 403, error: "Forbidden", code: "mcp_admin_only", message: "这个 MCP server 只有管理员能启用" });
        if (error) return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: error.message });
        const saved = await deps.projectMcp.store.put(id, {
          serverName: name, enabled: request.body.enabled, exposure: request.body.exposure ?? null,
          hiddenTools: [...new Set(request.body.hiddenTools ?? [])], updatedAt: Date.now(), updatedBy: ownerKey,
          serverIdentity: mcpServerIdentity(catalog.servers.get(name)!),
        });
        if (!saved) return NOT_FOUND(reply);
        const views = withEnableCapability(projectMcpServerViews(catalog, await deps.projectMcp.store.list(id)), true, isAdmin);
        return { server: views.find(view => view.name === name) };
      });
    // 项目信任（docs/configuration.md「项目信任」）：Pi 的 trust.json。项目可见者能看；只有 admin 能改，
    // 信任一个项目等于允许它的 .pi/mcp.json 在服务器上启动命令。改动对之后的消息与新会话生效。
    const projectTrustMissing = (reply: FastifyReply) =>
      reply.code(404).send({ statusCode: 404, error: "Not Found", code: "trust_not_configured", message: "服务未配置项目信任" });
    api.get<{ Params: { id: string } }>("/projects/:id/trust", { exposeHeadRoute: false, ...requirePermission("projects:list") }, async (request, reply) => {
      const root = await sessions.projectCwd(ownerKeyOf(request), request.params.id);
      if (!root) return NOT_FOUND(reply);
      if (!deps.projectTrust) return projectTrustMissing(reply);
      return reply.header("cache-control", "private, no-store").send(deps.projectTrust.status(root.cwd, request.access.role === "admin"));
    });
    api.put<{ Params: { id: string }; Body: import("../shared/project-trust.js").ProjectTrustInput }>("/projects/:id/trust",
      { schema: { body: PROJECT_TRUST_BODY_SCHEMA }, ...requirePermission("settings:admin") }, async (request, reply) => {
        const root = await sessions.projectCwd(ownerKeyOf(request), request.params.id);
        if (!root) return NOT_FOUND(reply);
        if (!deps.projectTrust) return projectTrustMissing(reply);
        try {
          deps.projectTrust.set(root.cwd, request.body.trusted);
        } catch (error) {
          // trust.json 写坏了或锁一直被占着：不覆盖，原因交给 admin。
          request.log.warn({ err: error }, "project trust not saved");
          return reply.code(409).send({ statusCode: 409, error: "Conflict", code: "trust_unavailable", message: error instanceof Error ? error.message : String(error) });
        }
        request.log.info({ projectTrust: { action: "update", projectId: request.params.id, trusted: request.body.trusted } }, "project trust saved");
        return reply.header("cache-control", "private, no-store").send(deps.projectTrust.status(root.cwd, true));
      });
    // 共享 MCP（docs/mcp-integration.md §14.3）：Pi 的全局 mcp.json。所有人能看列表；admin 能增删改，
    // 并拿到打码后的连接参数。写入要带 GET 给的文件 hash，文件在别处改过就返回 409。
    const sharedMcpMissing = (reply: FastifyReply) =>
      reply.code(404).send({ statusCode: 404, error: "Not Found", code: "mcp_not_configured", message: "服务未配置 MCP" });
    const sharedMcpError = (reply: FastifyReply, error: unknown) => {
      if (!(error instanceof SharedMcpConfigError)) throw error;
      if (error.code === "conflict") return reply.code(409).send({ statusCode: 409, error: "Conflict", code: "mcp_config_changed", message: error.message });
      if (error.code === "unknown_server") return reply.code(404).send({ statusCode: 404, error: "Not Found", code: "mcp_unknown_server", message: error.message });
      return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: "mcp_config_invalid", message: error.message });
    };
    api.get("/mcp/shared", { exposeHeadRoute: false, ...requirePermission("mcp:read") }, async (request, reply) => {
      if (!deps.sharedMcp) return sharedMcpMissing(reply);
      return reply.header("cache-control", "private, no-store")
        .send(sharedMcpList(deps.sharedMcp.file, deps.sharedMcp.catalog, request.access.role === "admin"));
    });
    api.put<{ Params: { name: string }; Body: SharedMcpServerInput }>("/mcp/shared/:name",
      { schema: { body: SHARED_MCP_SERVER_BODY_SCHEMA }, ...requirePermission("mcp:admin") }, async (request, reply) => {
        if (!deps.sharedMcp) return sharedMcpMissing(reply);
        const { name } = request.params;
        let created = false;
        try {
          await deps.sharedMcp.file.update(request.body.hash, servers => {
            created = !(name in servers);
            const entry = applySharedMcpForm(servers[name], request.body.server);
            validateSharedMcpEntry(name, entry, Object.keys(servers));
            servers[name] = entry;
          });
        } catch (error) {
          return sharedMcpError(reply, error);
        }
        request.log.info({ mcpShared: { action: created ? "add" : "update", name } }, "shared MCP server saved");
        return reply.header("cache-control", "private, no-store").send(sharedMcpList(deps.sharedMcp.file, deps.sharedMcp.catalog, true));
      });
    api.delete<{ Params: { name: string }; Querystring: { hash?: string } }>("/mcp/shared/:name", { ...requirePermission("mcp:admin") }, async (request, reply) => {
      if (!deps.sharedMcp) return sharedMcpMissing(reply);
      const { name } = request.params;
      const hash = request.query.hash;
      if (!hash) return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: "mcp_config_invalid", message: "缺少 hash" });
      try {
        await deps.sharedMcp.file.update(hash, servers => {
          if (!(name in servers)) throw new SharedMcpConfigError("unknown_server", "mcp.json 里没有这个 server");
          delete servers[name];
        });
      } catch (error) {
        return sharedMcpError(reply, error);
      }
      request.log.info({ mcpShared: { action: "remove", name } }, "shared MCP server removed");
      return reply.header("cache-control", "private, no-store").send(sharedMcpList(deps.sharedMcp.file, deps.sharedMcp.catalog, true));
    });
    // Agent 设置（docs/configuration.md「Agent 设置」）：Pi 全局 settings.json 里的自动压缩、自动重试和按模型的思考档位。
    // 所有人能看；admin 能改，写入要带 GET 给的文件 hash，文件在别处改过就返回 409。
    const agentSettingsMissing = (reply: FastifyReply) =>
      reply.code(404).send({ statusCode: 404, error: "Not Found", code: "settings_not_configured", message: "服务未配置 Agent 设置" });
    api.get<{ Querystring: { projectId?: string } }>("/settings", { exposeHeadRoute: false, schema: { querystring: PROJECT_QUERY_SCHEMA }, ...requirePermission("settings:read") }, async (request, reply) => {
      if (!deps.agentSettings) return agentSettingsMissing(reply);
      const projectCwd = await queriedProjectCwd(request);
      if (projectCwd === null) return NOT_FOUND(reply);
      return reply.header("cache-control", "private, no-store").send(deps.agentSettings.view(request.access.role === "admin", projectCwd));
    });
    api.put<{ Body: AgentSettingsInput }>("/settings",
      { schema: { body: AGENT_SETTINGS_BODY_SCHEMA }, ...requirePermission("settings:admin") }, async (request, reply) => {
        if (!deps.agentSettings) return agentSettingsMissing(reply);
        try {
          await deps.agentSettings.update(request.body.hash, request.body.values);
        } catch (error) {
          if (!(error instanceof AgentSettingsError)) throw error;
          if (error.code === "conflict") return reply.code(409).send({ statusCode: 409, error: "Conflict", code: "settings_changed", message: error.message });
          return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: "settings_invalid", message: error.message });
        }
        request.log.info({ agentSettings: { action: "update", fields: Object.keys(request.body.values) } }, "agent settings saved");
        return reply.header("cache-control", "private, no-store").send(deps.agentSettings.view(true));
      });
    // 按用户 MCP OAuth（docs/mcp-integration.md §13.10）：每个用户用自己的身份连接目录里的 oauth server。
    // 回调由对方授权页整页跳回，浏览器带不上 Bearer token，网络准入对这一个路径免 token；
    // state 一次性、10 分钟过期、只有发起授权的同一调用者能用。
    const mcpOAuthMissing = (reply: FastifyReply) =>
      reply.code(404).send({ statusCode: 404, error: "Not Found", code: "mcp_oauth_not_configured", message: "服务没有需要用户授权的 MCP server" });
    // 可选的 projectId：再加上这个项目（受信任时）.pi/mcp.json 里的 oauth server（docs/mcp-integration.md §15）。
    // 没给时为 undefined，看不到的项目为 null。
    const oauthProject = async (request: FastifyRequest<{ Querystring: { projectId?: string } }>) => {
      const projectCwd = await queriedProjectCwd(request);
      if (projectCwd === null) return null;
      const catalogs = deps.projectMcp?.projectCatalogs;
      return projectCwd && catalogs ? { id: request.query.projectId!, catalog: catalogs.forProject(projectCwd).catalog } : undefined;
    };
    api.get<{ Querystring: { projectId?: string } }>("/mcp/connections", { exposeHeadRoute: false, schema: { querystring: PROJECT_QUERY_SCHEMA }, ...requirePermission("mcp:connect") }, async (request, reply) => {
      const project = await oauthProject(request);
      if (project === null) return NOT_FOUND(reply);
      return reply.header("cache-control", "private, no-store").send({ servers: deps.mcpOAuth ? await deps.mcpOAuth.list(ownerKeyOf(request), project) : [] });
    });
    api.post<{ Params: { name: string }; Querystring: { projectId?: string } }>("/mcp/servers/:name/oauth/start", { schema: { querystring: PROJECT_QUERY_SCHEMA }, ...requirePermission("mcp:connect") }, async (request, reply) => {
      if (!deps.mcpOAuth) return mcpOAuthMissing(reply);
      const project = await oauthProject(request);
      if (project === null) return NOT_FOUND(reply);
      const result = await deps.mcpOAuth.start(ownerKeyOf(request), request.params.name, project);
      if ("authorizationUrl" in result) return reply.header("cache-control", "no-store").send(result);
      if (result.code === "unknown_server") return reply.code(404).send({ statusCode: 404, error: "Not Found", code: "mcp_unknown_server", message: result.message });
      return reply.code(502).send({ statusCode: 502, error: "Bad Gateway", code: `mcp_oauth_${result.code}`, message: result.message });
    });
    api.get<{ Querystring: { code?: string; state?: string; iss?: string; error?: string } }>("/mcp/oauth/callback",
      { exposeHeadRoute: false, ...requirePermission("mcp:connect") }, async (request, reply) => {
        if (!deps.mcpOAuth) return mcpOAuthMissing(reply);
        const pick = (key: "code" | "state" | "iss" | "error") => typeof request.query[key] === "string" ? request.query[key] : undefined;
        const query = { code: pick("code"), state: pick("state"), iss: pick("iss"), error: pick("error") };
        const result = await deps.mcpOAuth.complete(ownerKeyOf(request), Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)));
        const target = new URL(deps.mcpOAuth.returnUrl);
        target.searchParams.set("mcp_oauth", result.ok ? "connected" : result.reason);
        if (result.server) target.searchParams.set("mcp_server", result.server);
        return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(target.href, 302);
      });
    api.delete<{ Params: { name: string }; Querystring: { projectId?: string } }>("/mcp/servers/:name/connection", { schema: { querystring: PROJECT_QUERY_SCHEMA }, ...requirePermission("mcp:connect") }, async (request, reply) => {
      if (!deps.mcpOAuth) return mcpOAuthMissing(reply);
      const project = await oauthProject(request);
      if (project === null) return NOT_FOUND(reply);
      if (!(await deps.mcpOAuth.disconnect(ownerKeyOf(request), request.params.name, project))) {
        return reply.code(404).send({ statusCode: 404, error: "Not Found", code: "mcp_not_connected", message: "没有连接这个 MCP server" });
      }
      return reply.code(204).send();
    });
    // 模型登录（Pi 的 auth.json）：整个服务共用这份凭证，只有 admin 能看能改。登录是个来回多次的过程：
    // 发起后轮询登录记录，遇到问题（API key、授权码、选项）就回答；回答内容不进日志。
    const providerLoginsMissing = (reply: FastifyReply) =>
      reply.code(404).send({ statusCode: 404, error: "Not Found", code: "provider_auth_not_configured", message: "服务没有开放模型登录" });
    const providerLoginError = (reply: FastifyReply, error: unknown) => {
      if (!(error instanceof ProviderLoginError)) throw error;
      const status = error.code === "unknown_provider" || error.code === "unknown_login" ? 404 : error.code === "stale_prompt" ? 409 : 400;
      const label = status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Bad Request";
      return reply.code(status).send({ statusCode: status, error: label, code: `provider_auth_${error.code}`, message: error.message });
    };
    api.get("/provider-auth", { exposeHeadRoute: false, ...requirePermission("providers:admin") }, async (_request, reply) => {
      if (!deps.providerLogins) return providerLoginsMissing(reply);
      return reply.header("cache-control", "private, no-store").send(await deps.providerLogins.list());
    });
    api.post<{ Body: ProviderLoginStart }>("/provider-auth/logins",
      { schema: { body: PROVIDER_LOGIN_START_BODY_SCHEMA }, ...requirePermission("providers:admin") }, async (request, reply) => {
        if (!deps.providerLogins) return providerLoginsMissing(reply);
        try {
          const login = deps.providerLogins.start(ownerKeyOf(request), request.body.provider, request.body.method);
          request.log.info({ providerAuth: { action: "login", provider: login.provider, method: login.method } }, "provider login started");
          return reply.code(201).header("cache-control", "no-store").send(login);
        } catch (error) {
          return providerLoginError(reply, error);
        }
      });
    api.get<{ Params: { id: string } }>("/provider-auth/logins/:id", { exposeHeadRoute: false, ...requirePermission("providers:admin") }, async (request, reply) => {
      if (!deps.providerLogins) return providerLoginsMissing(reply);
      try {
        return reply.header("cache-control", "no-store").send(deps.providerLogins.get(ownerKeyOf(request), request.params.id));
      } catch (error) {
        return providerLoginError(reply, error);
      }
    });
    api.post<{ Params: { id: string }; Body: ProviderLoginAnswer }>("/provider-auth/logins/:id/answer",
      { schema: { body: PROVIDER_LOGIN_ANSWER_BODY_SCHEMA }, ...requirePermission("providers:admin") }, async (request, reply) => {
        if (!deps.providerLogins) return providerLoginsMissing(reply);
        try {
          return reply.header("cache-control", "no-store")
            .send(deps.providerLogins.answer(ownerKeyOf(request), request.params.id, request.body.promptId, request.body.value));
        } catch (error) {
          return providerLoginError(reply, error);
        }
      });
    api.delete<{ Params: { id: string } }>("/provider-auth/logins/:id", { ...requirePermission("providers:admin") }, async (request, reply) => {
      if (!deps.providerLogins) return providerLoginsMissing(reply);
      try {
        return reply.header("cache-control", "no-store").send(deps.providerLogins.cancel(ownerKeyOf(request), request.params.id));
      } catch (error) {
        return providerLoginError(reply, error);
      }
    });
    api.delete<{ Params: { provider: string } }>("/provider-auth/credentials/:provider", { ...requirePermission("providers:admin") }, async (request, reply) => {
      if (!deps.providerLogins) return providerLoginsMissing(reply);
      const before = await deps.providerLogins.list();
      if (!before.providers.some(provider => provider.id === request.params.provider && provider.stored)) {
        return reply.code(404).send({ statusCode: 404, error: "Not Found", code: "provider_auth_not_stored", message: "auth.json 里没有这个 provider 的凭证" });
      }
      await deps.providerLogins.logout(request.params.provider);
      request.log.info({ providerAuth: { action: "logout", provider: request.params.provider } }, "provider credential removed");
      return reply.header("cache-control", "private, no-store").send(await deps.providerLogins.list());
    });
    // The companion's persona follows the caller; only people who can start sessions meet it.
    // Without a store it reads as unset and a save is refused, so the page keeps it per browser.
    api.get("/companion/persona", { exposeHeadRoute: false, ...requirePermission("sessions:create") },
      async request => ({ persona: deps.companionPersonas ? await deps.companionPersonas.get(ownerKeyOf(request)) : null }));
    api.put<{ Body: import("../shared/companion.js").CompanionPersonaRecord }>("/companion/persona",
      { schema: { body: COMPANION_PERSONA_BODY_SCHEMA }, ...requirePermission("sessions:create") },
      async (request, reply) => {
        if (!deps.companionPersonas) {
          return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", code: "companion_unavailable", message: "人设暂不能保存" });
        }
        const persona = { ...request.body, name: request.body.name.trim() };
        await deps.companionPersonas.put(ownerKeyOf(request), persona, Date.now());
        return { persona };
      });
    api.post<{ Params: { id: string }; Body: import("../shared/commands.js").SessionCommandInput }>(
      "/sessions/:id/commands",
      { schema: { body: SESSION_COMMAND_BODY_SCHEMA }, ...requirePermission("sessions:control") },
      async (request, reply) => {
        if (request.body.command === "extension" && !request.body.name) {
          return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "扩展命令需要 name" });
        }
        const decision = await sessions.runCommand(ownerKeyOf(request), request.params.id, request.body);
        if (decision === "not-found") return NOT_FOUND(reply);
        switch (decision.kind) {
          case "ok": return reply.code(200).send(decision.result);
          case "conflict": return reply.code(409).send({ statusCode: 409, error: "Conflict", message: "会话正忙，请等当前任务结束后再执行命令" });
          case "aborted": return reply.code(409).send({ statusCode: 409, error: "Conflict", code: "COMMAND_ABORTED", message: "命令已取消" });
          case "unsupported": return reply.code(501).send({ statusCode: 501, error: "Not Implemented", message: "该会话不支持此命令" });
          case "failed": return reply.code(422).send({ statusCode: 422, error: "Unprocessable Entity", message: decision.message });
        }
      },
    );
    // 扩展命令打开的对话框：所有看得到会话的人都能看到问题，能操作会话的人才能回答，先答先得。
    api.get<{ Params: { id: string } }>("/sessions/:id/command-prompt",
      { exposeHeadRoute: false, ...requirePermission("sessions:events") }, async (request, reply) => {
        const prompt = await sessions.getCommandPrompt(ownerKeyOf(request), request.params.id);
        if (prompt === "not-found") return NOT_FOUND(reply);
        return reply.header("cache-control", "no-store").send({ prompt });
      });
    api.post<{ Params: { id: string }; Body: import("../shared/commands.js").CommandPromptAnswer }>("/sessions/:id/command-prompt",
      { schema: { body: COMMAND_PROMPT_ANSWER_BODY_SCHEMA }, ...requirePermission("sessions:control") }, async (request, reply) => {
        const result = await sessions.answerCommandPrompt(ownerKeyOf(request), request.params.id, request.body);
        if (result === "not-found") return NOT_FOUND(reply);
        if (result === "stale") return reply.code(409).send({ statusCode: 409, error: "Conflict", code: "command_prompt_closed", message: "这个问题已经回答过、被取消或已超时" });
        if (result === "invalid") return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: "command_prompt_invalid", message: "回答和问题类型不匹配" });
        return reply.code(204).send();
      });
    api.get<{ Params: { id: string } }>("/sessions/:id/control-queue",
      { ...requirePermission("sessions:export") }, async (request, reply) => {
        const snapshot = await sessions.getControlQueue(ownerKeyOf(request), request.params.id);
        return snapshot ? reply.code(200).send(snapshot) : NOT_FOUND(reply);
      });
    for (const operation of ["delete", "promote"] as const) {
      api.route<{ Params: { id: string; controlId: string }; Body: { requestId: string; acknowledgementId: string } }>({
        method: operation === "delete" ? "DELETE" : "POST",
        url: `/sessions/:id/control-queue/:controlId${operation === "promote" ? "/promote" : ""}`,
        schema: { body: CONTROL_MUTATION_BODY_SCHEMA, params: { type: "object", required: ["id", "controlId"],
          properties: { id: { type: "string" }, controlId: { type: "string", minLength: 1, maxLength: 128 } } } },
        ...requirePermission("sessions:control"),
        handler: async (request, reply) => {
          const result = await sessions.mutateControlQueue(ownerKeyOf(request), request.params.id,
            { controlId: request.params.controlId, ...request.body }, operation);
          return result === "not-found" ? NOT_FOUND(reply) : result.kind === "ok" ? reply.code(200).send(result.snapshot) : CONFLICT(reply);
        },
      });
    }
    for (const [path, operation] of [
      ["/sessions/:id/steer", "steer"],
      ["/sessions/:id/follow-ups", "follow-up"],
    ] as const) {
      api.post<{ Params: { id: string }; Body: { text: string } & Partial<import("../shared/steering.js").SteeringInput> }>(
        path,
        { schema: { body: STEERING_BODY_SCHEMA }, ...requirePermission("sessions:control") },
        async (request, reply) => {
          const normalized = normalizeImageInputs(request.body.images);
          if (!normalized.ok) return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: IMAGE_INPUT_REJECTION_MESSAGES[normalized.reason] });
          const steering = request.body.controlId ? { controlId: request.body.controlId,
            acknowledgementId: request.body.acknowledgementId!, requestId: request.body.requestId!,
            images: [...normalized.images] } : undefined;
          const result = await sessions.controlSession(ownerKeyOf(request), request.params.id, operation, request.body.text, undefined, steering);
          return result === "not-found" ? NOT_FOUND(reply) : result.kind === "ok" ? reply.code(steering ? 202 : 204).send() : CONFLICT(reply);
        },
      );
    }
    api.post<{ Params: { id: string }; Body: unknown }>(
      "/sessions/:id/abort",
      { ...requirePermission("sessions:control") },
      async (request, reply) => {
        const body = parseAbortBody(request.body);
        if (!body.ok) {
          return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "abort body 非法" });
        }
        let expectedRequestId: string | undefined;
        if (body.supplied) {
          const requestIdCheck = checkTurnText(body.expectedRequestId, TURN_TEXT_LIMITS.maxRequestIdLength);
          if (!requestIdCheck.ok) {
            return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "requestId 非法" });
          }
          expectedRequestId = requestIdCheck.value;
        }
        abortTrace("http.abort", { sessionId: request.params.id, requestId: expectedRequestId });
        const result = await withAbortTrace(request.params.id, () => sessions.controlSession(
          ownerKeyOf(request),
          request.params.id,
          "abort",
          undefined,
          expectedRequestId,
        ));
        abortTrace("http.abort.return", { sessionId: request.params.id, result: result === "not-found" ? result : result.kind });
        return result === "not-found"
          ? NOT_FOUND(reply)
          : result.kind === "ok"
            ? reply.code(204).send()
            : CONFLICT(reply, result.reason === "failback-in-progress" ? "MODEL_FAILBACK_IN_PROGRESS" : undefined);
      },
    );

    // SSE is a transport concern: headers, connection limits, heartbeats and byte backpressure stay in HTTP.
    // SSE GET-only：显式禁用 Fastify 自动 HEAD，避免 HEAD 执行下方配额/runtime/DB 路径。
    // 其它 /v1 GET 的默认 HEAD 兼容行为保持不变。
    api.get<{ Params: { id: string } }>("/sessions/:id/events", { exposeHeadRoute: false, ...requirePermission("sessions:events") }, async (request, reply) => {
      // WP5D-3 P2 顺序红线：关闭检查与配额检查+占位必须在任何 runtime 创建/查询**之前**同步完成
      // ——429/503 及后续所有拒绝路径零 adapter/DB/conversation_ref 副作用。
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
        // getExisting/getOrCreate 异常：释放占位后返回固定 500 文案（不吞异常原因；占位不残留）。
        // 与 export 一致：底层存储/SQL/路径细节绝不进入响应体，只保留 cause 供日志排查。
        releaseSlot();
        throw new Error("会话事件启动失败", { cause: error });
      }
      let outputAllowed: () => boolean;
      try {
        outputAllowed = await sessions.prepareOutputGuard(ownerKeyOf(request), request.params.id);
      } catch (error) {
        releaseSlot();
        throw new Error("会话事件启动失败", { cause: error });
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
        if (!outputAllowed()) {
          shouldClose = true;
          safeClose();
          void found.runtime.abort().catch(() => {});
          return false;
        }
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
      if (cleaned) { unsubscribe(); return; }
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
  const releaseAbortTrace = installAbortTrace();
  app.addHook("onClose", async () => {
    abortTrace("server.close", {}, true);
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (concurrency.activeCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await registry.abortAll();
    } finally {
      registry.dispose();
      try { await deps.onRuntimeClosed?.(); } finally { releaseAbortTrace(); }
    }
  });
  return app;
}
