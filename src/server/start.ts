// 启动入口：把真实 Pi SDK、SQLite 存储、真实鉴权、HTTP 层组装起来（needs.md §4.1/§7）。
// 服务端安全边界：
// - 独立 agentDir（不继承个人 ~/.pi/agent），DefaultResourceLoader 禁用项目/全局自动发现；
// - 凭证默认指向个人 ~/.pi/agent/auth.json（与 pi CLI 共用；OAuth token 刷新由 SDK 自动回写该文件，
//   生产部署应通过 PI_AUTH_PATH 指向服务端独立凭证）；服务端默认模型 API key 可从环境变量注入（setRuntimeApiKey，不落盘）。

import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildApp } from "./app.js";
import {
  DEFAULT_PROJECT_ID,
  toolPolicyFromAllowlist,
  type CredentialPort,
  type SystemPromptPort,
} from "../application/ports/index.js";
import { buildAuthenticate } from "./real-auth.js";
import { validateTrustProxyConfig } from "./trust-proxy-policy.js";
import { SessionDeletedError } from "../runtime/session-runtime.js";
import { SqliteSessionRepository } from "../storage/sqlite-session-repository.js";
import { SqliteProjectRepository } from "../storage/sqlite-project-repository.js";
import { SqliteIdempotencyRepository } from "../storage/sqlite-idempotency-repository.js";
import { PiAgentAdapter, type AgentSessionLike } from "../agent/pi-agent-adapter.js";
import { PiModelRuntimeCatalog } from "../model-adapters/pi-model-runtime-catalog.js";
import { PiModelRuntimeCredentials } from "../model-adapters/pi-model-runtime-credentials.js";
import { CapabilityRegistry, collectPromptFragmentSources } from "../application/capabilities/index.js";
import { ProviderAdapterRegistry } from "../provider-adapters/registry.js";
import { openAIToolPolicyAdapter } from "../provider-adapters/openai-tool-policy.js";
import {
  deepSeekV4FlashStreamAdapter,
  openCodeDeepSeekV4FlashFreeStreamAdapter,
} from "../provider-adapters/deepseek-v4/provider-adapter.js";

export type StartConfig = {
  host?: string;
  port: number;
  /** 服务数据库路径（SQLite）；默认 dataDir/pi-agent-server.db（持久化，重启后会话列表/历史可恢复）。 */
  dbPath?: string;
  /** 内网网段（来源 IP 命中即按 IP 识别身份，免 token）。 */
  intranetCidrs: string[];
  /** 公网 token → accountId 映射（pi-agent-server 签发账号，仅公网使用）。 */
  tokens: Record<string, string>;
  /** Agent 工作目录（工具/仓库根）。 */
  cwd?: string;
  /** 启用工具列表（未配置时默认只读工具 read/ls/find/grep；bash/edit/write 需显式开启）。 */
  tools?: string[];
  /** 服务数据目录（JSONL 会话 + 服务专用 agentDir；凭证默认不落此目录）。 */
  dataDir?: string;
  /** 服务专用 agentDir（默认 dataDir/.pi-agent），不继承个人 ~/.pi/agent。 */
  agentDir?: string;
  /** 凭证文件路径（默认 $HOME/.pi/agent/auth.json，与 pi CLI 共用，OAuth 刷新会回写该文件；PI_AUTH_PATH 可覆盖）。 */
  authPath?: string;
  /** 服务端默认模型 provider（如 "openai-codex"/"deepseek"），配合 modelApiKey 注入。 */
  modelProvider?: string;
  /** 服务端默认模型 API key（环境变量 PI_MODEL_API_KEY 注入，运行时注入不落盘）。 */
  modelApiKey?: string;
  /** 默认模型（provider + id）；仅未被会话配置覆盖的新会话使用。 */
  defaultModel?: { provider: string; id: string };
  /** 默认思考级别；仅未被会话配置覆盖的新会话使用。 */
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 可选系统提示词覆盖；未设置时使用 Pi SDK 内置默认提示词。 */
  systemPrompt?: string;
  /** 可信代理 IP 列表（反代部署时配置；默认 false 只信 TCP 对端，避免伪造 IP 绕过内网免登录）。 */
  trustProxy?: string | string[] | boolean;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** startServer 默认路径解析所需的配置子集。 */
export type ServerPathConfig = Pick<
  StartConfig,
  "cwd" | "dataDir" | "agentDir" | "authPath" | "dbPath"
>;

/** startServer 解析后的路径全集。 */
export type ResolvedServerPaths = {
  /** Agent 工作目录（工具/仓库根）。 */
  cwd: string;
  /** 服务数据目录（JSONL 会话 + 服务专用 agentDir）。 */
  dataDir: string;
  /** 服务专用 agentDir（默认 dataDir/.pi-agent），不继承个人 ~/.pi/agent。 */
  agentDir: string;
  /** 服务端 agent 配置里的模型文件（agentDir/models.json）。 */
  modelsPath: string;
  /** 凭证文件（默认 $HOME/.pi/agent/auth.json，与 pi CLI 共用；PI_AUTH_PATH 可覆盖）。 */
  authPath: string;
  /** 服务数据库路径（默认 dataDir/pi-agent-server.db）。 */
  dbPath: string;
};

/**
 * 解析 startServer 的路径默认值。
 * 约定：agentDir/modelsPath 落在 dataDir 下（服务端独立配置），
 * authPath 默认个人 $HOME/.pi/agent/auth.json（与 pi CLI 共用，OAuth 刷新回写）；
 * 显式传入的配置优先，其余均可用对应环境变量覆盖。
 */
export function resolveServerPaths(config: ServerPathConfig = {}): ResolvedServerPaths {
  const cwd = config.cwd ?? process.cwd();
  const dataDir = config.dataDir ?? cwd;
  const agentDir = config.agentDir ?? path.join(dataDir, ".pi-agent");
  const authPath = config.authPath ?? path.join(homedir(), ".pi", "agent", "auth.json");
  const dbPath = config.dbPath ?? path.join(dataDir, "pi-agent-server.db");
  return { cwd, dataDir, agentDir, modelsPath: path.join(agentDir, "models.json"), authPath, dbPath };
}

export async function startServer(config: StartConfig) {
  validateTrustProxyConfig(config.trustProxy, config.intranetCidrs);
  const { cwd, dataDir, agentDir, authPath, dbPath, modelsPath } = resolveServerPaths(config);

  // 模型运行时：凭证默认读个人 ~/.pi/agent/auth.json（与 pi CLI 共用，OAuth token 临近过期时 SDK 会自动
  // 刷新并回写该文件，同文件带锁并发安全）；生产部署可用 PI_AUTH_PATH 指向服务端独立凭证。
  // 服务端默认 API key 也可用 setRuntimeApiKey 运行时注入（不持久化，needs.md §7）。
  // 目录关系：dataDir（会话 JSONL）→ agentDir = dataDir/.pi-agent（agent 配置：models.json 等）；
  // authPath 默认 $HOME/.pi/agent/auth.json，三者均可用环境变量覆盖。
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath,
  });
  const credentials: CredentialPort = new PiModelRuntimeCredentials(modelRuntime);
  if (config.modelProvider && config.modelApiKey) {
    await credentials.setRuntimeApiKey(config.modelProvider, config.modelApiKey);
  }

  if (config.defaultThinkingLevel && !THINKING_LEVELS.has(config.defaultThinkingLevel)) {
    throw new Error(`不支持的默认思考级别：${config.defaultThinkingLevel}`);
  }
  const configuredDefaultModel = config.defaultModel
    ? modelRuntime.getModel(config.defaultModel.provider, config.defaultModel.id)
    : undefined;
  if (config.defaultModel && !configuredDefaultModel) {
    throw new Error(`默认模型不可用：${config.defaultModel.provider}/${config.defaultModel.id}`);
  }
  if (configuredDefaultModel && !credentials.hasConfiguredAuth(configuredDefaultModel.provider)) {
    throw new Error(`默认模型未配置凭证：${config.defaultModel?.provider}/${config.defaultModel?.id}`);
  }

  // 能力注册表：注册、启用、会话冻结与审计的唯一来源（阶段 4）。
  const capabilityRegistry = new CapabilityRegistry();
  // TODO(阶段4)：按配置注册已启用能力 manifest；当前无能力，工具清单与提示词片段为空。
  const capabilitySnapshot = capabilityRegistry.snapshot();

  // 独立 agentDir + 禁用所有自动发现（needs.md §7）：DefaultResourceLoader 默认会隐式扫描
  // 个人 ~/.pi/agent、项目 .pi/、AGENTS.md 等自动加载 extensions/skills/prompts/themes——
  // extensions 是代码，隐式加载是安全边界问题，必须关闭。pi-agent-server 自己的 extension/skill
  // 由能力 manifest 显式声明后，经 additionalExtensionPaths / extensionFactories /
  // additionalSkillPaths 受控注入（阶段 2 能力扩展机制），而非自动发现。
  const providerAdapters = new ProviderAdapterRegistry([openAIToolPolicyAdapter]);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // 未设置 PI_SYSTEM_PROMPT 时不覆盖，让 Pi SDK buildSystemPrompt() 生成其默认提示词。
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    // 能力提示词片段（inline 文本或文件路径）追加到系统提示词（Pi 原生支持）。
    appendSystemPrompt: collectPromptFragmentSources(capabilitySnapshot.promptFragments),
    // 服务内置且受控的协议兼容层；noExtensions 不会加载用户/项目扩展。
    extensionFactories: [
      {
        name: "pi-agent-server-provider-adapters",
        factory: (pi) => {
          // The provider override only wraps direct deepseek/deepseek-v4-flash;
          // every other model delegates to Pi's normal OpenAI-compatible stream.
          pi.registerProvider("deepseek", {
            api: "openai-completions",
            streamSimple: deepSeekV4FlashStreamAdapter,
          });
          pi.registerProvider("opencode", {
            api: "openai-completions",
            streamSimple: openCodeDeepSeekV4FlashFreeStreamAdapter,
          });
          pi.on("before_provider_request", (event, ctx) =>
            providerAdapters.adaptRequest(event.payload, ctx.model),
          );
        },
      },
    ],
  });
  await resourceLoader.reload();

  // 工具清单 = 已启用能力 manifest 声明的工具并集 ∪ 内置工具白名单（未配置时默认只读工具集）。
  const builtinGrant = toolPolicyFromAllowlist(config.tools).resolve();
  const builtinTools = builtinGrant.kind === "allowlist" ? [...builtinGrant.tools] : [];
  const allTools = [...new Set([...capabilitySnapshot.toolNames, ...builtinTools])];
  const agentToolConfig =
    allTools.length > 0 ? { tools: allTools } : { noTools: "all" as const };

  // 用与真实会话完全一致的 SDK 解析路径确定默认模型/思考级别/提示词，供 HTTP/UI 展示。
  // 使用内存 SessionManager，不写入 JSONL 或服务数据库。
  const { session: defaultSession } = await createAgentSession({
    sessionManager: SessionManager.inMemory(cwd),
    modelRuntime,
    resourceLoader,
    settingsManager: SettingsManager.inMemory(),
    cwd,
    ...(configuredDefaultModel ? { model: configuredDefaultModel } : {}),
    ...(config.defaultThinkingLevel ? { thinkingLevel: config.defaultThinkingLevel } : {}),
    ...agentToolConfig,
  });
  const resolvedDefaultModel = defaultSession.model;
  const defaultModel = resolvedDefaultModel
    ? {
        provider: String(resolvedDefaultModel.provider),
        id: resolvedDefaultModel.id,
        name: resolvedDefaultModel.name ?? resolvedDefaultModel.id,
      }
    : null;
  const defaultThinkingLevel = defaultSession.thinkingLevel;
  const defaultSystemPrompt = defaultSession.systemPrompt;
  defaultSession.dispose();

  // 默认项目复用已解析结果；额外项目的 Pi 默认提示词会包含各自 cwd，故单独解析。
  const systemPromptResolver: SystemPromptPort = {
    async resolve(projectCwd: string): Promise<string> {
      if (projectCwd === cwd) return defaultSystemPrompt;
      const { session } = await createAgentSession({
        sessionManager: SessionManager.inMemory(projectCwd),
        modelRuntime,
        resourceLoader,
        settingsManager: SettingsManager.inMemory(),
        cwd: projectCwd,
        ...(configuredDefaultModel ? { model: configuredDefaultModel } : {}),
        ...(config.defaultThinkingLevel ? { thinkingLevel: config.defaultThinkingLevel } : {}),
        ...agentToolConfig,
      });
      try {
        return session.systemPrompt;
      } finally {
        session.dispose();
      }
    },
  };

  // 会话元数据索引（SQLite）：默认落在 dataDir 下持久化，重启后经 piSessionFile 恢复 JSONL 历史。
  // timeout=5000：写锁等待（多连接/多进程并发写冲突时等待而非立即 SQLITE_BUSY）；
  // enableForeignKeyConstraints：开启外键约束检查（sessions.project_id → projects.id ON DELETE CASCADE）。
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
  // 先 projects 后 sessions：sessions.project_id 外键引用 projects(id)。
  const projects = new SqliteProjectRepository(db);
  // 默认项目落库（owner_key 空串 = 所有用户共享），满足外键引用；cwd 由运行时配置覆盖。
  await projects.ensureDefaultProject({
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    cwd,
    ownerKey: "",
    createdAt: 0,
  });
  const sessions = new SqliteSessionRepository(db);
  // 历史会话没有可恢复的独立副本；首次升级以 Pi 当前默认提示词补齐一次，
  // 后续服务端配置变化不会覆盖已写入的会话值。
  await sessions.backfillSystemPrompt(defaultSystemPrompt);
  const idempotencyRepo = new SqliteIdempotencyRepository(db);

  const authenticate = buildAuthenticate({
    intranetCidrs: config.intranetCidrs,
    tokens: config.tokens,
  });

  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: cwd,
    defaultModel,
    defaultThinkingLevel,
    modelCatalog: new PiModelRuntimeCatalog(modelRuntime),
    authenticate,
    createAdapter: async (sessionId) => {
      // 会话持久化映射（重启恢复）：查该会话的 Pi JSONL 路径，有则恢复，无则懒创建并记录。
      const record = await sessions.get(sessionId);
      // 会话已删（删除竞态）：禁止回退默认项目/cwd 创建 runtime，避免孤儿会话或错误 cwd 执行。
      if (!record) throw new SessionDeletedError(sessionId);
      // 多项目：默认项目用固定 cwd + dataDir/sessions；额外项目用各自 cwd + dataDir/projects/<pid>/sessions
      const projectId = record.projectId;
      const project =
        projectId === DEFAULT_PROJECT_ID
          ? { id: DEFAULT_PROJECT_ID, cwd }
          : await projects.get(projectId);
      // 所属项目已删：同样禁止回退默认 cwd。
      if (!project) throw new SessionDeletedError(sessionId);
      const projectCwd = project.cwd;
      const sessionDir =
        projectId === DEFAULT_PROJECT_ID
          ? path.join(dataDir, "sessions", sessionId)
          : path.join(dataDir, "projects", projectId, "sessions", sessionId);
      const sessionManager = record.piSessionFile
        ? SessionManager.open(record.piSessionFile)
        : SessionManager.create(projectCwd, sessionDir);

      // 会话级模型/思考级别覆盖服务端默认；已落 JSONL 的旧会话由 SDK 恢复其历史模型，
      // 不因修改服务端默认配置而被覆盖。
      const isNewSession = !record.piSessionFile;
      const model =
        record.modelProvider && record.modelId
          ? modelRuntime.getModel(record.modelProvider, record.modelId)
          : isNewSession
            ? configuredDefaultModel
            : undefined;
      const thinkingLevel = (record.thinkingLevel ?? (isNewSession ? defaultThinkingLevel : undefined)) as
        | "off"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max"
        | undefined;
      const { session } = await createAgentSession({
        sessionManager,
        modelRuntime,
        resourceLoader,
        settingsManager: SettingsManager.inMemory(),
        cwd: projectCwd,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        // 默认只开放只读工具 read/ls/find/grep；bash/edit/write 仅在显式配置 TOOLS 时按 allowlist 开放。
        // 知识库问答等能力工具由 manifest 显式注入（阶段 2），不走内置工具。
        ...agentToolConfig,
      });

      // 首次发消息时把 Pi 会话文件路径记到服务库，重启后据此恢复对话历史
      if (!record.piSessionFile && session.sessionFile) {
        await sessions.update(sessionId, { piSessionFile: session.sessionFile });
      }

      // 真实 AgentSession 结构满足 AgentSessionLike，此处用断言隔离 SDK 事件完整类型与我们的子集类型
      return new PiAgentAdapter(session as unknown as AgentSessionLike, (provider, modelId) =>
        modelRuntime.getModel(provider, modelId),
      );
    },
    trustProxy: config.trustProxy,
    idempotencyRepo,
    serverEpoch: randomUUID(),
    systemPrompt: defaultSystemPrompt,
    systemPromptResolver,
    capabilityVersions: capabilitySnapshot.versions,
  });

  await app.listen({ port: config.port, host: config.host ?? "127.0.0.1" });
  return app;
}
