// 启动入口：把真实 Pi SDK、SQLite 存储、真实鉴权、HTTP 层组装起来（needs.md §4.1/§7）。
// 服务端安全边界：
// - 独立 agentDir（不继承个人 ~/.pi/agent），DefaultResourceLoader 禁用项目/全局自动发现；
// - 凭证默认指向个人 ~/.pi/agent/auth.json（与 pi CLI 共用；OAuth token 刷新由 SDK 自动回写该文件，
//   生产部署应通过 PI_AUTH_PATH 指向服务端独立凭证）；服务端默认模型 API key 可从环境变量注入（setRuntimeApiKey，不落盘）。

import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import {
  DEFAULT_PROJECT_ID,
  DefaultAgentSessionFactoryRegistry,
  ConversationStorageRegistry,
  toolPolicyFromAllowlist,
  type CredentialPort,
  type SystemPromptPort,
} from "../application/ports/index.js";
import { requireIpAccessRuntimeConfig } from "./network-admission.js";
import type { IpAccessResolveInput } from "../core/ip-access-policy.js";
import { createIdempotentStorageCloser } from "./storage-close.js";
import { createOperationStatus, validateMigrationGate, validateDataMode, enforceDataModeGate, type DataMode } from "./ops-status.js";
import { SessionConversationCoordinator } from "../application/session-conversation-coordinator.js";
import { PiAgentSessionFactory } from "../agent/pi-agent-session-factory.js";
import { PiJsonlConversationStorage } from "../agent/pi-jsonl-conversation-storage.js";
import { runSqliteMigrations } from "../storage/migration-engine.js";
import { initializeDatabaseVerifyOnly } from "../storage/bootstrap.js";
import { sqliteConstraintErrorMapper } from "../storage/sqlite-constraint-errors.js";
import { pgConstraintErrorMapper } from "../storage/pg-constraint-errors.js";
import { createPostgresPool, initializePostgresDatabaseVerifyOnly } from "../storage/postgres-bootstrap.js";
import {
  resolveAgentDir,
  resolveStorageConfig as resolveSharedStorageConfig,
  resolveStoragePaths,
  type ResolvedStorage,
} from "../storage/storage-config.js";
import type { DatabaseSchema } from "../storage/db-schema.js";

export { resolveStoragePaths } from "../storage/storage-config.js";
export type { ResolvedStorage } from "../storage/storage-config.js";
export type { DataMode } from "./ops-status.js";
import type { Kysely } from "kysely";
import { KyselySessionRepository } from "../storage/kysely-session-repository.js";
import { KyselyProjectRepository } from "../storage/kysely-project-repository.js";
import { KyselyIdempotencyRepository } from "../storage/kysely-idempotency-repository.js";
import { KyselyFileOperationRepository } from "../storage/kysely-file-operation-repository.js";
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
  /**
   * 存储方言：sqlite（默认，向后兼容）或 postgres（需显式开启）。
   * 未配置/空白或 "sqlite" → SQLite（DatabaseSync + WAL）；"postgres" → PG Pool（需 databaseUrl）。
   * 未知**非空**值 fail-fast，绝不静默回退。
   */
  storageDialect?: StorageDialect;
  /** 服务数据库路径（SQLite）；默认 dataDir/pi-agent-server.db（持久化，重启后会话列表/历史可恢复）。 */
  dbPath?: string;
  /**
   * WP5D-2 网络准入配置（严格必填，无默认）：allowedClientCidrs + 可选 policy。
   * 进程入口由 main 经 parseIpAccessEnv + loadIpAccessPolicy 解析；此处（含 buildApp）做运行时
   * 严格 shape 校验——缺失/伪造/字段非法一律在任何资源创建前 failfast（JS/typed bypass 同样拒绝）。
   */
  ipAccess: IpAccessResolveInput;
  /**
   * PostgreSQL 连接串（仅 storageDialect=postgres 时必填，缺失 fail-fast）。
   * 进程入口由 PI_DATABASE_URL 提供；单独设置该变量而未设 PI_STORAGE_DIALECT=postgres 时
   * 仍按 SQLite 默认（向后兼容，绝不隐式启用 PG）。
   */
  databaseUrl?: string;
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
  defaultModel?: { provider: string; id: string };
  /** 默认思考级别；仅未被会话配置覆盖的新会话使用。 */
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 可选系统提示词覆盖；未设置时使用 Pi SDK 内置默认提示词。 */
  systemPrompt?: string;
  /**
   * 测试注入点（生产不配置，恒定无操作）：存储初始化完成（Kysely + 四个 Repository + 默认项目
   * + backfill）之后、buildApp 之前回调。供测试观测/注入启动中段失败，验证启动失败/成功路径的
   * 幂等 storage close（见 tests/server/start-server-lifecycle.test.ts）。回调抛错走与生产一致的
   * 启动失败清理路径（closeStorage 幂等销毁 + 原始错误向上抛），不改变生产行为。
   */
  onStorageReady?: (kysely: Kysely<DatabaseSchema>) => Promise<void> | void;
  /**
   * 数据模式仅用于部署分类；不会放宽启动迁移边界。无论 managed 或 rc，服务都必须在
   * 启动前由离线 migration 建立并 verify 单一基线。
   */
  dataMode?: "managed" | "rc";
  /**
   * 严格启动 migration 门禁（唯一允许值为 "verify"，默认）：在任何 bootstrap/DDL 前只读
   * 校验 migration ledger/head；空库、legacy 库与落后库均 fail-fast。服务启动绝不 apply
   * migration、reset 或 bootstrap baseline；只能先运行离线 `pnpm migrate -- --apply`。
   * `off`/rc+off 已删除，任何显式值均在资源创建前拒绝。
   */
  migrationGate?: "off" | "verify";
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 严格生产 migration 门禁失败时的统一 fail-fast 语义：绝不自动迁移，明确指引离线 migrate。 */
function startupMigrationGateError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `startup migration gate: storage is not at the migration head; refusing to start. ` +
    `Run the offline migration (pnpm migrate -- --apply) first. Detail: ${detail}`,
  );
}

interface GateFileFingerprint {
  readonly exists: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string | null;
}

/** 完整 DB/WAL/SHM 指纹：门禁前后必须逐字节/逐 stat 一致，否则视为门禁触碰了源库。 */
function sqliteGateFingerprint(dbPath: string): Record<string, GateFileFingerprint> {
  const fingerprints: Record<string, GateFileFingerprint> = {};
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      const st = statSync(file);
      let sha256: string | null = null;
      if (st.isFile()) sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      fingerprints[file] = { exists: true, dev: st.dev, ino: st.ino, nlink: st.nlink, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs, sha256 };
    } catch {
      fingerprints[file] = { exists: false, dev: 0, ino: 0, nlink: 0, mode: 0, size: 0, mtimeMs: 0, sha256: null };
    }
  }
  return fingerprints;
}

/**
 * SQLite migration 门禁（migrationGate="verify"）：真只读。
 * - DB 文件不存在 → 直接 fail-fast，绝不创建/初始化文件；
 * - 已存在的库：复制 DB/WAL/SHM 到私有临时目录后在副本上校验（WAL 下直接 readonly 打开
 *   仍可能触碰 -shm），源库零写入；门禁前后对源 DB/WAL/SHM 做完整 stat+sha256 指纹比对，
 *   任何变化都视为门禁破坏了只读边界而失败。
 */
async function runSqliteMigrationGateReadonly(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    throw startupMigrationGateError(new Error(`database file does not exist; the startup gate never creates or initializes a database`));
  }
  const before = sqliteGateFingerprint(dbPath);
  const directory = mkdtempSync(path.join(tmpdir(), ".pi-agent-migration-gate-"));
  chmodSync(directory, 0o700);
  let gateError: unknown;
  try {
    const copy = path.join(directory, "gate-snapshot.db");
    for (const suffix of ["", "-wal", "-shm"] as const) {
      const source = `${dbPath}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${copy}${suffix}`);
    }
    const db = new DatabaseSync(copy, { timeout: 5000, readOnly: true, enableForeignKeyConstraints: true });
    try {
      await runSqliteMigrations(db, { mode: "verify" });
    } finally {
      try { db.close(); } catch { /* gateError below keeps the original failure */ }
    }
  } catch (error) {
    gateError = error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
    const after = sqliteGateFingerprint(dbPath);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw startupMigrationGateError(new Error("the source database changed during the startup migration gate; read-only boundary violated"));
    }
  }
  if (gateError) throw startupMigrationGateError(gateError);
}

/** 支持的存储方言：sqlite（默认）/ postgres（显式开启）。 */
export type StorageDialect = "sqlite" | "postgres";

/** startServer 解析后的存储形态：SQLite（dbPath）或 PostgreSQL（数据库连接串）。 */

/**
 * 解析并校验存储配置（fail-fast，不静默回退）：
 * - 未指定 storageDialect、空串或仅空白（如进程入口 PI_STORAGE_DIALECT= 或 "   "）→
 *   归一化为未配置 → SQLite（默认，向后兼容；即便配置了 databaseUrl 也不启用 PG）；
 * - 显式 "sqlite" → SQLite；
 * - "postgres" → 必须提供非空 databaseUrl，否则抛错拒绝启动；
 * - 未知**非空**方言值 → 抛错拒绝启动（空/空白不 fail-fast，未知有内容的值 fail-fast）。
 */

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
  const storagePaths = resolveStoragePaths(config, {}, process.cwd());
  const agentDir = resolveAgentDir(storagePaths.dataDir, config.agentDir);
  const authPath = config.authPath?.trim() ? path.resolve(config.authPath.trim()) : path.join(homedir(), ".pi", "agent", "auth.json");
  return {
    ...storagePaths,
    agentDir,
    modelsPath: path.join(agentDir, "models.json"),
    authPath,
  };
}

/** Compatibility export: service and offline CLI use the same pure resolver. */
export function resolveStorageConfig(
  config: Pick<StartConfig, "storageDialect" | "databaseUrl" | "dbPath">,
  defaultDbPath: string,
): ResolvedStorage {
  return resolveSharedStorageConfig(config, defaultDbPath);
}

export async function startServer(config: StartConfig) {
  // WP5D-2：网络准入配置在任何资源创建/网络访问之前严格校验（failfast）。
  // 缺失/非法/伪造即拒绝（JS/typed bypass 同样 fail），错误消息不回显值。
  const ipAccess = requireIpAccessRuntimeConfig(config.ipAccess);
  // 只接受精确 "verify"（undefined/null 归一化为 "verify"）；任何 off/未知值
  // （含大小写/空白变体）一律拒绝启动，且不回显原始值。
  const migrationGate = validateMigrationGate(config.migrationGate);
  // 数据模式不改变 verify-only 语义；检查仍在任何资源创建/网络访问之前执行。
  const dataMode = validateDataMode(config.dataMode);
  enforceDataModeGate(dataMode, migrationGate);
  const { cwd, dataDir, agentDir, authPath, dbPath, modelsPath } = resolveServerPaths(config);
  // 存储方言 + 连接配置先于任何资源创建/网络访问解析（fail-fast：PG URL 缺失/未知方言在此抛错）。
  const storage = resolveStorageConfig(config, dbPath);

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

  // WP5A 运行状态（生产组合唯一注入点；buildApp 缺省对象恒未就绪，仅测试/非生产组合使用）：
  // - ready：listen 成功后才置真（失败路径进程不监听，ready 恒 false）；
  // - migrationGateVerified：仅当启用 gate（"verify"）且启动门禁实际校验通过后置真。
  // 运行状态：服务入口只会注入 verify，只有实际只读校验通过才置 verified。
  const ops = createOperationStatus({
    migrationGate,
    storageDialect: storage.dialect,
  });

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

  // 会话元数据索引（SQLite/PG）：默认落在 dataDir 下持久化，重启后经 conversation_ref 恢复 Agent Session。
  // timeout=5000：写锁等待（多连接/多进程并发写冲突时等待而非立即 SQLITE_BUSY）；
  // enableForeignKeyConstraints：开启外键约束检查（sessions.project_id → projects.id ON DELETE CASCADE）。
  // 上述 SQLite 专有选项仅在该方言分支生效；PG 用 Pool（PostgresDialect），FK/并发语义由 PG 自身保证。
  // 幂等 storage close：成功路径（app.close 上的 onClose）与失败路径（schema 初始化后 / listen 抛错）
  // 共用同一 closer，保证 Kysely/底层存储在整个生命周期内恰好销毁/关闭一次，不重复、不遗漏。
  // PG 场景 destroy 会调用 pool.end()（Kysely PostgresDriver.destroy → pool.end）。
  if (migrationGate === "off") {
    throw new Error('migrationGate "off" 已删除：服务启动必须先由离线 migration 建立并 verify 基线（当前值不回显）');
  }

  // The config validator currently permits only verify; this branch remains an
  // explicit runtime assertion so future type changes cannot re-enable bootstrap.
  if (migrationGate !== "verify") throw new Error("startup migration gate must be verify");

  let kysely: Kysely<DatabaseSchema> | null = null;
  const closeStorage = createIdempotentStorageCloser(async () => {
    if (kysely) await kysely.destroy();
  });

  let app: FastifyInstance;
  try {
    // 只在已由离线 migration 建立、并已通过启动只读门禁的 schema 上构造 Repository。
    // 初始化不会创建业务表或 baseline ledger。
    if (storage.dialect === "postgres") {
      // verify-only：单一 Pool/Kysely（无独立 gate pool），在同一个连接上做严格
      // non-public schema + migration head 校验，绝不 bootstrap 或写入 ledger。
      // 同一 Kysely 亦用作 Repository；门禁通过后才置 verified。
      // Startup verification must fail promptly when the configured PostgreSQL endpoint is unavailable;
      // the same pool is retained for repositories after the read-only check completes.
      const pool = createPostgresPool(storage.databaseUrl, {
          connectionTimeoutMillis: 5_000,
          statementTimeoutMs: 10_000,
          queryTimeoutMs: 10_000,
        });
      try {
        kysely = await initializePostgresDatabaseVerifyOnly(pool);
      } catch (error) {
        throw startupMigrationGateError(error);
      }
      // WP5A：门禁实际校验通过后才置 verified（/readyz schema=migration-head、/metrics gate verified=1）。
      ops.migrationGateVerified = true;
    } else {
      // verify-only：gate 在打开实际读写连接之前做副本上的只读 ledger/head 校验；
      // 空库、legacy 与落后库都不会被服务启动初始化。
      if (migrationGate === "verify") {
        await runSqliteMigrationGateReadonly(storage.dbPath);
        // WP5A：门禁实际校验通过后才置 verified。
        ops.migrationGateVerified = true;
      }
      const db = new DatabaseSync(storage.dbPath, {
        timeout: 5000,
        enableForeignKeyConstraints: true,
      });
      // 已通过只读 gate；verify-only 初始化对实际读写连接再严格校验 head（杜绝 TOCTOU），
      // 只建 Kysely，绝不 bootstrap（不建表、索引或 baseline ledger）。
      try {
        kysely = await initializeDatabaseVerifyOnly(db);
      } catch (error) {
        throw startupMigrationGateError(error);
      }
      // WP5A：门禁实际校验通过后才置 verified（与 SQLite gate 一致，重复设置无副作用）。
      ops.migrationGateVerified = true;
    }
    const constraintMapper =
      storage.dialect === "postgres" ? pgConstraintErrorMapper : sqliteConstraintErrorMapper;
    // 四个 Repository 共享同一 Kysely 实例；默认项目在 schema 初始化后经 ensureDefaultProject 创建
    // （INSERT … ON CONFLICT DO NOTHING 幂等：不覆盖既有默认项目；异常既有行 fail-fast）。
    const fileOperations = new KyselyFileOperationRepository(
      kysely,
      storage.dialect === "postgres" ? "postgres" : "sqlite",
    );
    const conversationStorage = new ConversationStorageRegistry();
    const piStorage = new PiJsonlConversationStorage(dataDir);
    conversationStorage.register(piStorage);
    const agentFactories = new DefaultAgentSessionFactoryRegistry();
    const piFactory = new PiAgentSessionFactory({
      modelRuntime,
      resourceLoader,
      defaultModel: configuredDefaultModel,
      defaultThinkingLevel,
      agentToolConfig,
    });
    agentFactories.register(piFactory);
    const cleanupPlan = (input: Parameters<PiJsonlConversationStorage["planCleanup"]>[0]) =>
      conversationStorage.require(input.conversation).planCleanup(input);
    const repositoryOptions = {
      fileOperations,
      cleanupPlan,
    } as const;
    const projects = new KyselyProjectRepository(kysely, constraintMapper, {
      ...repositoryOptions,
      dialect: storage.dialect,
    });
    await projects.ensureDefaultProject({
      id: DEFAULT_PROJECT_ID,
      name: "默认项目",
      cwd,
      ownerKey: "",
      createdAt: 0,
    });
    const sessions = new KyselySessionRepository(kysely, constraintMapper, repositoryOptions);
    // 对当前数据库中仍为 NULL 的系统提示词做防御性补齐；正常新会话创建时已冻结该值。
    await sessions.backfillSystemPrompt(defaultSystemPrompt);
    const idempotencyRepo = new KyselyIdempotencyRepository(kysely);
    const sessionConversationCoordinator = new SessionConversationCoordinator({
      sessions,
      projects,
      factories: agentFactories,
      conversationStorage,
      fileOperations,
      defaultProjectCwd: cwd,
      dataDir,
      defaultThinkingLevel,
      agentToolConfig,
    });
    // 测试注入点（生产不传，无操作）：存储初始化完成后、buildApp 前回调，用于验证
    // 启动失败/成功路径的幂等 storage close（抛错即进入下方 catch 的统一清理路径）。
    await config.onStorageReady?.(kysely);

    app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: cwd,
    defaultModel,
    defaultThinkingLevel,
    modelCatalog: new PiModelRuntimeCatalog(modelRuntime),
    // WP5D-2：准入配置已在函数入口严格校验（requireIpAccessRuntimeConfig），此处直接注入。
    ipAccess,
    // 未实例化会话的只读导出由通用 registry 分派到 Pi JSONL storage。
    conversationStorage,
    createAdapter: (sessionId) => sessionConversationCoordinator.createAdapter(sessionId),
    idempotencyRepo,
    serverEpoch: randomUUID(),
    systemPrompt: defaultSystemPrompt,
    systemPromptResolver,
    capabilityVersions: capabilitySnapshot.versions,
    ops,
  });

  // 关闭流程：destroy Kysely（经 NodeSqliteAdapter 关闭底层 DatabaseSync）与既有 runtime 清理
  // （buildApp 注册的 preClose/onClose）一起在 app.close() 时执行，不破坏既有 SSE/并发清理。
  app.addHook("onClose", closeStorage);

  await app.listen({ port: config.port, host: config.host ?? "127.0.0.1" });
  // WP5A：listen 成功（安全启动完成）才置 ready；listen 抛错走下方 catch，ready 恒 false。
  ops.ready = true;
  ops.readyAt = Date.now();
  return app;
  } catch (error) {
    // 初始化成功后的任一 init 或 listen 失败：在此幂等销毁 Kysely/DatabaseSync，再向上抛原始错误。
    // 清理本身失败只记录、不掩盖原始错误：cleanupError 绝不覆盖原始 error（throw error 是最终退出路径）。
    try {
      await closeStorage();
    } catch (cleanupError) {
      console.error("启动失败路径 storage close 失败（原始错误仍会向上抛出）:", cleanupError);
    }
    throw error;
  }
}
