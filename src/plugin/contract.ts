// 公开插件契约（docs/external-capability-plugin-plan.md §插件接入契约）：
// 受信外部插件只依赖本文件与 Pi SDK 的公开类型，不得引用 pi-agent-server 内部模块。
// 宿主按显式配置加载插件并校验；插件是工程边界，不是进程级安全隔离。
//
// 两阶段启动：
//   阶段一（加载/校验）由 PluginLoader 完成：只解析并校验插件模块，绝不产生副作用，
//   也绝不调用 register / dispose；
//   阶段二（注册）由宿主在准备好 PluginHostContext 后调用 LoadedPlugin.plugin.register，
//   停止时由宿主调用同一模块的 dispose。插件经上下文注册能力，
//   不直接修改宿主 Fastify 实例、会话存储或内部数据库。

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TURN_ERROR_CODES } from "../application/ports/session-runtime-port.js";

/**
 * `runTurn` 预算超限的稳定 error code 表（宿主的 `TURN_ERROR_CODES` 的类型投影）。
 * 插件**不在本地重复定义**这些字符串：运行时值由 {@link PluginHostContext.turnErrorCodes}
 * 注入（插件按绝对路径加载，不能静态 import 宿主包）。
 */
export type PluginTurnErrorCodes = typeof TURN_ERROR_CODES;

/**
 * Pi 内置工具保留名（Pi createAllToolDefinitions 的键）：
 * 插件工具不得占用这些名称，否则会覆盖宿主内置工具。
 */
export const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** 系统提示词片段：inline 内联文本或 file 资源路径，二者必须且只能选一。 */
export interface PluginPromptFragment {
  /** 内联片段文本。 */
  inline?: string;
  /** 片段文件的绝对路径；插件应通过 import.meta.url 解析自身资源，宿主不依赖进程 cwd。 */
  file?: string;
}

/**
 * manifest 中声明的 Agent 可见工具（元数据）。
 * 执行实现由 {@link PluginModule.tools} 提供，名称必须一一对应；
 * 声明了 description 时须与实现一致。
 */
export interface PluginToolDeclaration {
  /** Agent 可见的稳定工具名。 */
  name: string;
  /** 工具类别；未声明时按只读处理。 */
  category?: "read" | "write" | "execute";
  /** 工具用途说明（与 ToolDefinition.description 一致时声明）。 */
  description?: string;
}

/**
 * Copilot mode profile：每个 mode 绑定固定模型与系统提示词。
 * 宿主据此为该 mode 创建、查询、恢复独立 session，模式之间不复制上下文。
 *
 * 提示词两种声明方式**必须且只能二选一**（加载器与宿主双重校验）：
 * - {@link PluginModeProfile.appendSystemPrompt}：追加到宿主解析出的完整系统提示词
 *   （Pi 默认提示词或服务端整体提示词）之后；这是宿主**通用**能力，不包含任何插件专属逻辑。
 * - {@link PluginModeProfile.systemPrompt}：旧版整体覆盖，不再是首选，仅为兼容既有插件保留。
 */
export interface PluginModeProfile {
  /** mode 稳定 id（同一插件内唯一）。 */
  readonly id: string;
  /** 模型供应商（如 "anthropic"）。 */
  readonly modelProvider: string;
  /** 模型 id（如 "claude-sonnet-4"）。 */
  readonly modelId: string;
  /**
   * 追加到系统提示词的片段，与 {@link PluginModeProfile.systemPrompt} 二选一（非空）。
   * 宿主先用 SystemPromptPort 解析该 mode 所属项目的完整提示词，再安全追加并把结果冻结
   * 为会话快照；恢复会话时按字面量复用快照，绝不重复追加。
   */
  readonly appendSystemPrompt?: string;
  /**
   * 该 mode 的系统提示词整体覆盖（旧语义，保持不变的兼容路径）。
   * 与 {@link PluginModeProfile.appendSystemPrompt} 二选一（非空）；提供时宿主不调用解析器，
   * 也不追加任何默认提示词。
   */
  readonly systemPrompt?: string;
  /** 可选思考级别；具体合法值由宿主会话配置校验。 */
  readonly thinkingLevel?: string;
}

/** 受信外部插件的能力声明：标识、版本、Agent 可见工具、提示词片段与 mode profile。 */
export interface PluginManifest {
  /** 稳定唯一 id（小写字母/数字/连字符），如 "onev"。 */
  id: string;
  /** manifest 版本号（会话冻结与审计依据）。 */
  version: number;
  /** 展示名（可选）。 */
  name?: string;
  /** 声明的 Agent 可见工具；省略等价于不声明任何工具。 */
  tools?: readonly PluginToolDeclaration[];
  /** 注入系统提示词的片段。 */
  promptFragments?: readonly PluginPromptFragment[];
  /** 声明的 Copilot mode profile；也可在 {@link PluginModule.modes} 上声明（后者优先）。 */
  modes?: readonly PluginModeProfile[];
  /**
   * 插件自声明的业务能力标识；键名即能力投影响应体的键名（如 "canBind"）。
   * 宿主不解释这些标识的语义，只保证：未声明的标识永远不出现在投影中，
   * 且每个声明过的标识必须在 register 阶段通过 declareCapabilities 绑定到一个权限档位。
   */
  capabilities?: readonly string[];
}

/** 插件路由访问级别；宿主映射到固定 capability:read / capability:write / capability:admin RBAC。 */
export type PluginRouteAccess = "read" | "write" | "admin";

/**
 * 权限档位的运行时白名单（冻结三个值）。插件包是运行时 JS，不是 TypeScript，
 * 因此 access 与能力声明必须显式收口为本集合，未知值一律 fail-closed。
 * 对象自身也被冻结，避免受信插件改写同一模块实例使白名单失效。
 */
export const PLUGIN_ROUTE_ACCESS = Object.freeze(["read", "write", "admin"] as const);

/** 插件业务能力标识（manifest.capabilities 的条目）：键名即投影响应体的键名。 */
export const PLUGIN_CAPABILITY_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
/** 单个插件可声明的业务能力数量上限。 */
export const PLUGIN_CAPABILITY_LIMIT = 32;

/** 插件 HTTP 方法。 */
export type PluginHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 受宿主鉴权后的插件路由上下文；ownerKey 只能由宿主从请求身份推导。 */
/**
 * 宿主已授权的插件权限档位投影（通用词汇，不含任何插件业务语义）。
 *
 * 这是区分权限的**受支持入口**：不要反查 `request.access`（见下）。
 * `request`/`reply` 是透传的宿主对象，技术上可读到 role/IP，但那是未经承诺的内部细节，
 * 会在宿主重构时静默失效，因此不属于插件契约。
 */
export type PluginCapabilityTiers = {
  readonly read: boolean;
  readonly write: boolean;
  readonly admin: boolean;
};

export interface PluginRouteRequestContext {
  /** 宿主从已认证请求身份推导，仅供插件关联自己的业务记录。 */
  readonly ownerKey: string;
  /** 已绑定当前认证 owner 的会话 API；插件不能传入或伪造 owner。 */
  readonly sessions: PluginSessionApi;
  /**
   * 本次调用方的权限档位投影，由中央 RBAC 矩阵派生（与路由 gate 同源）。
   * 供插件在同一插件内做更细粒度判断（如“本请求能否执行管理级变更”）。
   */
  readonly capabilities: PluginCapabilityTiers;
  /**
   * 透传的宿主请求/响应对象（插件只应用其公开的请求面：params/query/body/headers）。
   * 这是不稳定的内部载体：不要依赖其中的身份字段（如 `access.role`）；
   * 需要权限判断请读 {@link PluginCapabilityTiers}。
   */
  readonly request: unknown;
  readonly reply: unknown;
}

/** 插件路由处理器占位签名；请求/响应载体由宿主实现时注入，不暴露 Fastify 类型。 */
export type PluginRouteHandler = (
  context: PluginRouteRequestContext,
) => unknown | Promise<unknown>;

/** 插件 HTTP 路由声明：只声明 method/path/access/handler，命名空间与挂载由宿主完成。 */
export interface PluginRoute {
  readonly method: PluginHttpMethod;
  readonly path: string;
  readonly access: PluginRouteAccess;
  readonly handler: PluginRouteHandler;
}

/** 挂载插件路由的宿主入口；插件经此声明路由，不直接接触 Fastify。 */
export type PluginMountRoute = (route: PluginRoute) => void;

/** 宿主会话引用；会话正文与持久化始终归 pi-agent-server。 */
export interface PluginSessionRef {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * `runTurn` 的宿主强制上限：requestId / prompt 与返回给插件的助手文本。
 * 插件无法调整这些上限，也无法指定模型、工具、cwd 或图片。
 */
/**
 * 自动会话标题的宿主边界。插件负责从其已接受的首条 user 消息中提取业务标题；
 * 宿主只接受纯文本并强制这个长度/控制字符预算，不解析插件业务 envelope。
 */
export const PLUGIN_SESSION_TITLE_LIMITS = {
  /** UTF-16 code units；UI 应按普通文本渲染，绝不当作 HTML。 */
  maxLength: 80,
} as const;

export const PLUGIN_RUN_TURN_LIMITS = {
  /** requestId 的最大长度（UTF-16 code units）。 */
  maxRequestIdLength: 128,
  /** prompt 的最大长度（UTF-16 code units）。 */
  maxPromptLength: 32_768,
  /** 单轮返回给插件的 assistant 文本最大长度；超过即中止本轮并返回 error。 */
  maxAssistantTextLength: 256 * 1024,
  /**
   * 单轮工具调用总次数上限（成功与失败都计数）；超过即中止本轮并返回带
   * `turn_tool_budget_exceeded` 的 error。
   * 取值理由：实测病理轮次（交互原型生成）跑了 89 次工具调用，正常生成远低于 60。
   */
  maxToolCallsPerTurn: 60,
  /**
   * 单轮墙钟上限（毫秒，5 分钟）；超过即中止本轮并返回带
   * `turn_duration_budget_exceeded` 的 error。
   * 取值理由：实测最慢成功轮次 273 秒，病理轮次 403 秒（属于不可接受的病理轮次，
   * 明显超出本预算；当时前端超时仍是 300 秒，现已提到 600 秒）。
   */
  maxTurnDurationMs: 300_000,
} as const;

/**
 * `runTurn` 的结果：宿主用 session 创建时冻结的 mode profile 同步执行一轮，
 * 并绑定到具体 session/requestId；插件不能指定模型、tools、cwd 或图片。
 *
 * error 上的 `code` 为 additive 可选字段：宿主预算超限时为稳定值
 * （`turn_tool_budget_exceeded` / `turn_duration_budget_exceeded` /
 * `turn_assistant_text_budget_exceeded`），插件据此区分预算超限与一般上游失败。
 */
export type PluginTurnResult =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "aborted" }
  | { readonly status: "error"; readonly message: string; readonly code?: string }
  | { readonly status: "busy" };

/**
 * 宿主预分配的会话预约：会话 id 只能由宿主生成，插件既不能指定也不能伪造。
 * 预约仅在**同一次插件路由请求**内有效，未消费的预约随请求上下文回收。
 */
export interface PluginSessionReservation {
  /** 宿主生成的会话 id；插件只能原样回传，不能自行构造。 */
  readonly id: string;
  /** 预约绑定的 mode；宿主在 create 时据此解析 mode profile。 */
  readonly modeId: string;
}

/**
 * 受信插件可调用的会话 API；mode 到 session 的历史映射由插件自己的数据库保存。
 *
 * 会话创建采用两步式预约：插件先 `reserve` 取得宿主生成的安全 id，把 mode↔session
 * 映射原子写入自身数据库后，再用 `create` 按预约 id 创建宿主会话；这样宿主会话永远
 * 不会先于插件映射存在，插件也**没有删除任意会话的 API**。
 */
export interface PluginSessionApi {
  /**
   * 宿主预分配一个安全会话 id（插件不可指定 id）。预约绑定当前认证 owner 与 mode，
   * 只在本次路由请求内有效；未消费的预约随请求结束回收。
   */
  reserve(input: { modeId: string }): Promise<PluginSessionReservation>;
  /**
   * 按宿主预约创建会话：只接受本请求 `reserve` 返回且尚未消费的预约（伪造/跨请求/
   * 重复使用的预约一律拒绝）。成功即消费预约并返回宿主会话；失败时预约作废且绝不
   * 创建会话。会话 id 严格等于预约 id。
   */
  create(input: { reservation: PluginSessionReservation; title?: string }): Promise<PluginSessionRef>;
  restore(sessionId: string): Promise<PluginSessionRef | null>;
  /**
   * 读取当前认证 owner 指定 session 在创建时冻结的系统提示词；会话不存在、无权访问或
   * 未记录提示词时均返回 null，插件不能借此读取其他 owner 的会话。
   */
  getSystemPrompt(sessionId: string): Promise<string | null>;
  /**
   * 只读取得当前认证 owner 会话的导出 messages；不存在或不属于该 owner 返回 null。
   * 返回内容对宿主不透明，宿主不解析任何插件业务 envelope，也不返回 timeline/thinking。
   */
  getMessages(sessionId: string): Promise<unknown | null>;
  /**
   * 更新当前认证 owner 的会话标题；不存在或不属于该 owner 返回 null。
   *
   * 插件负责决定何时命名以及从已接受的 user 消息中提取安全纯文本；宿主不理解
   * 插件业务 envelope，也不从模型输出推断标题。`title` 必须是非空、不含非法控制
   * 字符且不超过 {@link PLUGIN_SESSION_TITLE_LIMITS.maxLength} 的字符串。`onlyIfEmpty`
   * 为 true 时原子地仅更新空标题，并返回当前会话（含已有标题）。调用只更新宿主
   * 会话元数据，不改变插件自己的 mode 映射或用户自定义标题标记。
   */
  setTitle(input: { sessionId: string; title: string; onlyIfEmpty?: boolean }): Promise<PluginSessionRef | null>;
  /**
   * 在当前认证 owner 的指定 session 上**同步**执行一轮对话，返回助手最终文本。
   *
   * - owner 由宿主从请求身份推导；插件不能传 owner、模型、tools、cwd 或图片；
   * - `requestId` 与 `prompt` 受 {@link PLUGIN_RUN_TURN_LIMITS} 限制；
   * - 结果绑定到具体 session 的这一轮：idle 时立即执行，session 正忙返回 `busy`；
   * - 返回文本受上限约束，覆盖 `completed` / `aborted` / `error` / `busy`；
   * - 单轮还受 {@link PLUGIN_RUN_TURN_LIMITS.maxToolCallsPerTurn}（默认 60 次工具调用）与
   *   {@link PLUGIN_RUN_TURN_LIMITS.maxTurnDurationMs}（默认 5 分钟）约束：超限即快速失败，
   *   返回带稳定 `code` 的 `error`，不跑到调用方超时；这些预算仅作用于 `runTurn`，
   *   不影响普通聊天轮次（`POST /v1/sessions/:id/messages`）；
   * - 宿主不建立 HTTP 回调或长期订阅，handler 返回后（API 被 revoke）调用会抛错。
   */
  /** Explicit plugin-owned cancellation, independent of the HTTP connection/proxy. */
  readonly supportsTurnCancellation?: boolean;
  runTurn(input: { sessionId: string; requestId: string; prompt: string; signal?: AbortSignal }): Promise<PluginTurnResult>;
}

/** 插件 register 时宿主提供的受限上下文（阶段二）。 */
export interface PluginHostContext {
  /** 宿主默认项目目录；插件查询命令在此目录执行。 */
  readonly projectCwd: string;
  /** 该插件声明并已通过校验的 Copilot mode profile。 */
  readonly modes: readonly PluginModeProfile[];
  /** 挂载插件 HTTP 路由。 */
  readonly mountRoute: PluginMountRoute;
  /**
   * 声明「本插件业务 flag → 宿主通用权限档位」。宿主不解释 flag 语义，只保证：
   * - flag 必须已在 manifest.capabilities 中声明（否则 fail-fast）；
   * - 档位必须是 read/write/admin 之一（否则 fail-fast）；
   * - 每个声明过的 flag 必须恰好映射一次；未映射的 flag 不会出现在投影中（fail-closed）。
   * 宿主据此自动挂载只读投影端点 `GET /v1/capabilities/<plugin-id>/access`。
   */
  readonly declareCapabilities: (map: Readonly<Record<string, PluginRouteAccess>>) => void;
  /**
   * `runTurn` 预算超限的稳定 error code 表（宿主 `TURN_ERROR_CODES` 的同一对象）。
   * 插件据此把预算超限映射成可行动文案，而不在本地维护副本；
   * 旧宿主未注入时插件回退到内置兜底值，因此本字段是 additive。
   */
  readonly turnErrorCodes?: PluginTurnErrorCodes;
}

/** 可选注册钩子：阶段二由宿主调用，插件在此注册工具/路由等能力。 */
export type PluginRegister = (context: PluginHostContext) => void | Promise<void>;

/** 可选关闭钩子：宿主停止插件时调用，由插件自行释放资源。 */
export type PluginDispose = () => void | Promise<void>;

/**
 * 插件入口模块：能力声明 + Pi 工具实现 + 可选生命周期钩子。
 * 加载/校验阶段禁止产生副作用；register / dispose 只由宿主在阶段二与停止时调用。
 */
export interface PluginModule {
  /** 能力声明。 */
  readonly manifest: PluginManifest;
  /** 工具定义及其受控执行实现（类型复用 Pi SDK）。 */
  readonly tools?: readonly ToolDefinition[];
  /** 覆盖 {@link PluginManifest.modes} 的运行时 mode 声明。 */
  readonly modes?: readonly PluginModeProfile[];
  /** 可选注册钩子（阶段二由宿主调用）。 */
  readonly register?: PluginRegister;
  /** 可选关闭钩子。 */
  readonly dispose?: PluginDispose;
}

/** 显式插件来源：已导入的内联模块或由宿主解析的 ESM package specifier。 */
export type PluginSource = PluginModule | string;

/** 通过校验、尚未 register 的插件视图。 */
export interface LoadedPlugin {
  /** 规范化后的能力声明。 */
  readonly manifest: PluginManifest;
  /** 已通过 manifest/实现一致性校验的工具定义。 */
  readonly tools: readonly ToolDefinition[];
  /** manifest 声明的提示词片段。 */
  readonly promptFragments: readonly PluginPromptFragment[];
  /** 已通过校验的 Copilot mode profile（module.modes 优先，其次 manifest.modes）。 */
  readonly modes: readonly PluginModeProfile[];
  /** 已通过校验的业务能力标识（manifest.capabilities）；未声明为空数组。 */
  readonly capabilities: readonly string[];
  /** 原始插件模块；宿主稍后调用其 register / dispose。 */
  readonly plugin: PluginModule;
}
