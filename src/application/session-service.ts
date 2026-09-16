import type {
  IdempotencyStorePort,
  ModelCatalogPort,
  ModelDescriptor,
  ProjectRecord,
  ProjectStorePort,
  ConversationStorageRegistry,
  SessionRecord,
  SessionRecordPatch,
  SessionStorePort,
  SessionTurnResult,
  SystemPromptPort,
} from "./ports/index.js";
import { PLUGIN_RUN_TURN_LIMITS } from "../plugin/contract.js";
import { readPiSessionCwdIdentity } from "../agent/pi-jsonl-conversation-storage.js";
import type { ImageInput } from "../agent/agent-adapter.js";
import {
  DEFAULT_PROJECT_ID,
  DuplicateIdError,
  PI_AGENT_KIND,
  PI_CONVERSATION_FORMAT,
  ProjectForeignKeyError,
} from "./ports/index.js";
import {
  RuntimeRegistry,
  SessionDeletedError,
  type SessionEntry,
} from "../runtime/runtime-registry.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Accept legacy adapters/readers while exposing the additive timeline field on every HTTP export. */
function normalizeExportSnapshot(value: unknown): { messages: unknown; timeline: unknown[] } {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as { messages?: unknown; timeline?: unknown };
    if ("messages" in record) return { messages: record.messages, timeline: Array.isArray(record.timeline) ? record.timeline : [] };
  }
  return { messages: value, timeline: [] };
}

/**
 * 系统提示词追加分隔符：与 Pi SDK `buildSystemPrompt` 的 append 段一致（空行分隔），
 * 保证宿主追加的片段在形态上与 Pi 原生 appendSystemPrompt 无差异。
 */
const SYSTEM_PROMPT_APPEND_SEPARATOR = "\n\n";

/**
 * 主键/唯一 ID 冲突的有界重试上限：INSERT 撞库后用新 ID 最多再重试 MAX_ID_RETRIES 次
 * （共 MAX_ID_RETRIES + 1 次尝试）；同一上限也作为项目保留值连续命中的防御性 bound。
 */
export const MAX_ID_RETRIES = 3;

export type SessionDto = Omit<SessionRecord, "agentKind" | "conversationFormat" | "conversationRef">;
/** 项目 DTO：仅默认项目（id = DEFAULT_PROJECT_ID）为 isDefault: true，其余项目为 false。 */
export type ProjectDto = { id: string; name: string; cwd: string; isDefault: boolean };

export type SessionServiceDeps = {
  sessions: SessionStorePort;
  projects: ProjectStorePort;
  registry: RuntimeRegistry;
  defaultProjectCwd: string;
  defaultProjectName?: string;
  modelCatalog?: ModelCatalogPort;
  defaultModel?: ModelDescriptor | null;
  defaultThinkingLevel?: string;
  systemPrompt?: string;
  systemPromptResolver?: SystemPromptPort;
  /** 创建会话时冻结的能力版本快照（id→version）。 */
  capabilityVersions?: Readonly<Record<string, number>>;
  /** 按 agent kind/format 分派未实例化会话的只读导出；缺省仅允许空引用返回空历史。 */
  conversationStorage?: ConversationStorageRegistry;
  /** 由 composition root 提供，便于隔离 ID 生成策略。 */
  createId: () => string;
  /** 由 composition root 提供，便于测试并隔离时钟。 */
  now: () => number;
};

export type ConfigResult =
  | { kind: "not-found" }
  | { kind: "model-pair-required" }
  | { kind: "invalid-thinking-level" }
  | { kind: "invalid-model" }
  | { kind: "model-check-failed" }
  | { kind: "updated"; session: SessionDto };

export type CreateSessionResult =
  | { kind: "created"; session: SessionDto }
  | { kind: "project-not-found" }
  | { kind: "invalid-model" }
  | { kind: "invalid-thinking-level" }
  | { kind: "model-check-failed" }
  /** 仅指定/预约 id 的创建路径：id 已存在，绝不换 id 重试（重试会破坏预约语义）。 */
  | { kind: "id-conflict" };

export type SubmitResult =
  | { found: false }
  | {
      found: true;
      decision: Awaited<ReturnType<SessionEntry["runtime"]["submitMessage"]>>;
    };

/**
 * 插件同步轮次结果（宿主内部）：与公开 `PluginTurnResult` 一致；
 * `runTurn` 额外可用 `null` 表示会话不存在/不属于当前 owner。
 */
export type RunTurnResult = SessionTurnResult;

export class SessionService {
  /** 删除进行中的项目墓碑：拒绝并发创建会话到正在删除的项目（避免留下孤儿会话）。 */
  private readonly deletingProjects = new Set<string>();

  constructor(private readonly deps: SessionServiceDeps) {}

  async models(): Promise<{
    models: readonly ModelDescriptor[];
    thinkingLevels: readonly string[];
    defaultModel: ModelDescriptor | null;
    defaultThinkingLevel: string;
  }> {
    return {
      models: this.deps.modelCatalog ? await this.deps.modelCatalog.getAvailable() : [],
      thinkingLevels: THINKING_LEVELS,
      defaultModel: this.deps.defaultModel ?? null,
      defaultThinkingLevel: this.deps.defaultThinkingLevel ?? "medium",
    };
  }

  async listProjects(ownerKey: string): Promise<ProjectDto[]> {
    return [
      this.defaultProject(),
      ...(await this.deps.projects.listByOwner(ownerKey)).map(toProjectDto),
    ];
  }

  async createProject(ownerKey: string, input: { name: string; cwd: string }): Promise<ProjectDto | null> {
    const name = input.name.trim();
    const cwd = input.cwd.trim();
    if (!name || !cwd) return null;
    // 撞库是极低概率事件；仅对存储无关的 DuplicateIdError（仓库层已转换）用新 ID 有界重试，
    // 其余错误（仓库守卫/约束）原样抛出，不静默吞掉。createdAt 在重试循环外冻结（与 createSession 一致）。
    const createdAt = this.deps.now();
    for (let attempt = 0; ; attempt++) {
      const record: ProjectRecord = {
        id: this.nextProjectId(),
        name,
        cwd,
        ownerKey,
        createdAt,
      };
      try {
        await this.deps.projects.create(record);
        return toProjectDto(record);
      } catch (error) {
        if (!(error instanceof DuplicateIdError)) throw error;
        if (attempt >= MAX_ID_RETRIES) {
          throw new Error(
            `创建项目失败：主键/唯一 ID 冲突超过重试上限（共 ${MAX_ID_RETRIES + 1} 次尝试）`,
            { cause: error },
          );
        }
      }
    }
  }

  /** @returns default / not-found / deleted, preserving HTTP's existing outcome distinctions. */
  async deleteProject(ownerKey: string, projectId: string): Promise<"default" | "not-found" | "deleted"> {
    if (projectId === DEFAULT_PROJECT_ID) return "default";
    const project = await this.deps.projects.get(projectId);
    if (!project || project.ownerKey !== ownerKey) return "not-found";

    // 墓碑：删除期间拒绝并发创建会话到本项目
    this.deletingProjects.add(projectId);
    try {
      let deletedSessionIds: readonly string[];
      const repositoryDelete = this.deps.projects.deleteProjectWithSessionsAndReturnSessionIds;
      if (repositoryDelete) {
        // The production repository returns the ids from its locked
        // parent/list/enqueue/delete transaction.  No unlocked snapshot is
        // taken before that transaction.
        deletedSessionIds = await repositoryDelete.call(this.deps.projects, projectId, []);
      } else {
        // Compatibility adapters may only implement the old void method.
        const owned = await this.deps.sessions.listByProject(ownerKey, projectId);
        await this.deps.projects.deleteProjectWithSessions(projectId, owned.map((r) => r.id));
        deletedSessionIds = owned.map((record) => record.id);
      }
      // 仅清理进程内 runtime；文件副作用由持久 outbox 的未来 worker 执行。
      for (const sessionId of deletedSessionIds) {
        await this.cleanupRuntimeById(sessionId);
      }
    } finally {
      this.deletingProjects.delete(projectId);
    }
    return "deleted";
  }

  async createSession(
    ownerKey: string,
    input: {
      title?: string;
      projectId?: string;
      modelProvider?: string;
      modelId?: string;
      thinkingLevel?: string;
      /**
       * 系统提示词**整体覆盖**（旧语义，保持不变，仅为兼容既有插件保留）。
       * 与 {@link systemPromptAppend} 二选一且非空；提供时不调用解析器。
       */
      systemPromptOverride?: string;
      /**
       * 系统提示词**追加**（宿主通用能力，不含任何插件专属逻辑）：宿主先用
       * {@link SessionServiceDeps.systemPromptResolver} 解析项目的完整提示词（Pi 默认
       * 提示词或服务端整体提示词），再把该片段安全追加到末尾并冻结为会话快照。
       * 与 {@link systemPromptOverride} 二选一且非空；恢复会话时按快照字面量复用，绝不重复追加。
       */
      systemPromptAppend?: string;
      /**
       * 宿主预约的会话 id（仅插件宿主内部使用，HTTP 层不暴露）。提供时必须为合法
       * 且未占用的 id；撞库返回 id-conflict 而**不**换 id 重试，保证预约 id 语义。
       */
      sessionId?: string;
    },
  ): Promise<CreateSessionResult> {
    if (input.systemPromptOverride !== undefined && input.systemPromptOverride.trim() === "") {
      throw new Error("会话系统提示词覆盖不能为空");
    }
    if (input.systemPromptAppend !== undefined && input.systemPromptAppend.trim() === "") {
      throw new Error("会话系统提示词追加不能为空");
    }
    // 覆盖（旧语义）与追加（通用新能力）互斥：二者同时提供会让「Pi 默认提示词是否保留」
    // 变得不确定，因此在这里 fail-fast，绝不静默选择其一。
    if (input.systemPromptOverride !== undefined && input.systemPromptAppend !== undefined) {
      throw new Error("会话系统提示词覆盖与追加不能同时提供");
    }
    const reservedId = input.sessionId;
    if (reservedId !== undefined) assertReservedSessionId(reservedId);
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    // 项目删除进行中：拒绝创建会话，避免留下孤儿会话
    if (this.deletingProjects.has(projectId)) return { kind: "project-not-found" };
    const project = await this.resolveProject(ownerKey, projectId);
    if (!project) return { kind: "project-not-found" };

    // thinkingLevel 枚举校验（纯本地，先于模型目录检查，与 configureSession 顺序一致）
    if (input.thinkingLevel !== undefined && !THINKING_LEVELS.includes(input.thinkingLevel as never)) {
      return { kind: "invalid-thinking-level" };
    }
    // 模型字段必须成对且非空（应用层防御，HTTP 层由 schema dependencies + minLength 拦截）：
    // 半字段/空字符串/不可用模型一律 invalid-model，避免静默回退默认模型
    const { modelProvider: createProvider, modelId: createModelId } = input;
    const hasCreateProvider = createProvider !== undefined;
    const hasCreateId = createModelId !== undefined;
    if (hasCreateProvider !== hasCreateId) return { kind: "invalid-model" };
    if (hasCreateProvider && (createProvider === "" || createModelId === "")) return { kind: "invalid-model" };
    if (hasCreateProvider) {
      let available: boolean;
      try {
        available = this.deps.modelCatalog
          ? await this.deps.modelCatalog.isAvailable(createProvider as string, createModelId as string)
          : false;
      } catch {
        return { kind: "model-check-failed" };
      }
      if (!available) return { kind: "invalid-model" };
    }

    const now = this.deps.now();
    const base: Omit<SessionRecord, "id"> = {
      ownerKey,
      projectId,
      title: input.title ?? "",
      createdAt: now,
      updatedAt: now,
      agentKind: PI_AGENT_KIND,
      conversationFormat: PI_CONVERSATION_FORMAT,
      conversationRef: null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      systemPrompt: await this.resolveSystemPrompt(project.cwd, input),
      capabilityVersions: this.deps.capabilityVersions
        ? JSON.stringify(this.deps.capabilityVersions)
        : null,
    };
    // 删除竞态二次防护：systemPrompt 解析期间项目可能被删（墓碑进行中或已删）
    if (this.deletingProjects.has(projectId) || !(await this.resolveProject(ownerKey, projectId))) {
      return { kind: "project-not-found" };
    }
    // 撞库是极低概率事件；仅对存储无关的 DuplicateIdError（仓库层已转换）用新 ID 有界重试，
    // 其余错误原样抛出。指定/预约 id 的路径不重试：换 id 会破坏预约映射，撞库直接返回
    // id-conflict。
    for (let attempt = 0; ; attempt++) {
      const record: SessionRecord = { ...base, id: reservedId ?? this.deps.createId() };
      try {
        await this.deps.sessions.create(record);
        return { kind: "created", session: toSessionDto(record) };
      } catch (error) {
        // 并发删除项目导致 project_id 失效（仓库层已转换为存储无关 ProjectForeignKeyError）：
        // 外键约束兑底，把竞态窗口的脏数据风险变成明确的 404「项目不存在」，而非 500。
        // 外键错误属「非重复 ID」错误，不做重试/转换，仍按既有语义处理。
        if (error instanceof ProjectForeignKeyError) return { kind: "project-not-found" };
        if (!(error instanceof DuplicateIdError)) throw error;
        if (reservedId !== undefined) return { kind: "id-conflict" };
        if (attempt >= MAX_ID_RETRIES) {
          throw new Error(
            `创建会话失败：主键/唯一 ID 冲突超过重试上限（共 ${MAX_ID_RETRIES + 1} 次尝试）`,
            { cause: error },
          );
        }
      }
    }
  }

  async listSessions(ownerKey: string, projectId?: string): Promise<SessionDto[]> {
    const records = projectId
      ? await this.deps.sessions.listByProject(ownerKey, projectId)
      : await this.deps.sessions.listByOwner(ownerKey);
    return records.map(toSessionDto);
  }

  /**
   * 返回 owner 自己的会话在创建时冻结的系统提示词。不存在、越权及未记录提示词统一为
   * null，避免将其他 owner 的会话存在性或内容暴露给调用方。
   */
  async getSystemPrompt(ownerKey: string, id: string): Promise<string | null> {
    return (await this.findOwned(ownerKey, id))?.systemPrompt ?? null;
  }

  async deleteSession(ownerKey: string, id: string): Promise<boolean> {
    const record = await this.findOwned(ownerKey, id);
    if (!record) return false;
    await this.deleteRecord(record);
    return true;
  }

  async renameSession(ownerKey: string, id: string, title: string): Promise<SessionDto | null> {
    if (!(await this.findOwned(ownerKey, id))) return null;
    await this.deps.sessions.update(id, { title, updatedAt: this.deps.now() });
    const updated = await this.deps.sessions.get(id);
    return updated ? toSessionDto(updated) : null;
  }

  async configureSession(
    ownerKey: string,
    id: string,
    input: { modelProvider?: string; modelId?: string; thinkingLevel?: string },
  ): Promise<ConfigResult> {
    if (!(await this.findOwned(ownerKey, id))) return { kind: "not-found" };
    const entry = await this.findEntry(ownerKey, id);
    if (!entry) return { kind: "not-found" };
    const { modelProvider, modelId, thinkingLevel } = input;
    // 成对校验按字段存在性（非 truthiness），空字符串同样拦截
    const hasProvider = modelProvider !== undefined;
    const hasId = modelId !== undefined;
    if (hasProvider !== hasId) {
      return { kind: "model-pair-required" };
    }
    if (hasProvider && (modelProvider === "" || modelId === "")) {
      return { kind: "model-pair-required" };
    }
    if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as never)) {
      return { kind: "invalid-thinking-level" };
    }
    // 模型有效性校验（与 createSession 一致）：切换前先确认可用，避免 setModel 抛错成 500 或持久化不可用模型
    if (hasProvider) {
      let available: boolean;
      try {
        available = this.deps.modelCatalog
          ? await this.deps.modelCatalog.isAvailable(modelProvider as string, modelId as string)
          : false;
      } catch {
        return { kind: "model-check-failed" };
      }
      if (!available) return { kind: "invalid-model" };
      await entry.runtime.setModel(modelProvider as string, modelId as string);
    }
    if (thinkingLevel !== undefined) await entry.runtime.setThinkingLevel(thinkingLevel);
    // 只把显式提供的字段写入 patch：不用 null 表示「未提供」，避免依赖存储实现（如 COALESCE）的特殊语义
    const patch: SessionRecordPatch = { updatedAt: this.deps.now() };
    if (modelProvider !== undefined) patch.modelProvider = modelProvider;
    if (modelId !== undefined) patch.modelId = modelId;
    if (thinkingLevel !== undefined) patch.thinkingLevel = thinkingLevel;
    await this.deps.sessions.update(id, patch);
    const updated = await this.deps.sessions.get(id);
    return updated ? { kind: "updated", session: toSessionDto(updated) } : { kind: "not-found" };
  }

  async submitMessage(
    ownerKey: string,
    id: string,
    input: { requestId: string; prompt: string; parentId?: string; images?: ImageInput[] },
  ): Promise<SubmitResult> {
    const entry = await this.findEntry(ownerKey, id);
    if (!entry) return { found: false };
    return {
      found: true,
      decision: await entry.runtime.submitMessage({ ...input, userId: ownerKey }),
    };
  }

  /**
   * 在指定 session 上同步执行一轮并返回助手文本（插件宿主专用，HTTP 层不暴露）。
   *
   * - owner 必须拥有会话；不存在/越权返回 null。
   * - 宿主只用 session 创建时冻结的 mode profile，不接受模型/tools/cwd/图片参数。
   * - 文本/终态由 runtime 按 requestId 专属累计与结算，绝不订阅 session 级事件流，
   *   因此旧请求在 submit 异步窗口内到达的事件不会串入本请求。
   * - 仅 idle 时提交并等待 completed/aborted/error；session 忙（active 冲突、限流或
   *   全局排队）返回 busy 并撤销排队，绝不留下后台任务。
   * - signal 触发只终止本 requestId 对应的 task，不误杀其他 task，也不因脱离 client
   *   的请求拖住撤销/优雅停机。
   * - 助手文本超过 {@link PLUGIN_RUN_TURN_LIMITS.maxAssistantTextLength} 时中止本轮并返回 error。
   */
  async runTurn(
    ownerKey: string,
    input: { sessionId: string; requestId: string; prompt: string; signal?: AbortSignal },
  ): Promise<RunTurnResult | null> {
    const entry = await this.findEntry(ownerKey, input.sessionId);
    if (!entry) return null;
    return entry.runtime.runTurn({
      requestId: input.requestId,
      prompt: input.prompt,
      maxAssistantTextLength: PLUGIN_RUN_TURN_LIMITS.maxAssistantTextLength,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }

  /**
   * 导出会话快照（WP5D-3 P1：真只读，绝不实例化 runtime）。
   * 顺序：先查 owned 记录（越权/不存在一律 null）；已存在 runtime → 活会话导出
   * （事件游标 + adapter 投影，快照语义「至少一次」不变）；无 runtime 且未持久化
   * （conversationRef null）→ 空消息 + 游标 0；无 runtime 但已持久化 → 注入的
   * ConversationStorage 只读解析（与活会话导出同一 role/text 投影），绝不
   * createAdapter / 写 DB / 改写会话历史。
   */
  async exportSession(ownerKey: string, id: string): Promise<{ messages: unknown; timeline: unknown[]; lastEventId: number } | null> {
    const record = await this.findOwned(ownerKey, id);
    if (!record) return null;
    // 已实例化 runtime：活会话导出（registry.get 仅读取，绝不因导出触发创建）。
    const existing = this.deps.registry.get(id);
    if (existing) {
      const lastEventId = existing.events.lastEventId;
      const exported = normalizeExportSnapshot(await existing.runtime.exportSession());
      return { ...exported, lastEventId };
    }
    // 无 runtime：从未活跃（或重启后未实例化）的会话——零写入只读路径。
    const conversation = {
      agentKind: record.agentKind,
      conversationFormat: record.conversationFormat,
      conversationRef: record.conversationRef,
    };
    if (!this.deps.conversationStorage) {
      // 测试/非生产组合未注入存储时，只有未物化会话可以安全返回空历史；
      // 已有引用不能回退到可写的 getOrCreate/createAdapter 路径。
      if (conversation.conversationRef === null) return { messages: [], timeline: [], lastEventId: 0 };
      throw new Error("会话历史只读解析不可用（服务配置缺失）");
    }
    try {
      const exported = normalizeExportSnapshot(await this.deps.conversationStorage.require(conversation).readExport(conversation, {
        sessionId: record.id,
        projectId: record.projectId,
      }));
      return { ...exported, lastEventId: 0 };
    } catch (error) {
      // 错误脱敏：只暴露固定文案，不透出文件路径/内容/解析细节（实现层同样兜底）。
      throw new Error("会话历史读取失败", { cause: error });
    }
  }

  /** Resolve only the creation-time JSONL root identity; mutable project/AGENT_CWD is never a preview fallback. */
  async sessionProjectCwd(ownerKey: string, id: string): Promise<{ cwd: string; dev: number; ino: number } | null> {
    const record = await this.findOwned(ownerKey, id);
    if (!record || record.conversationRef === null || record.agentKind !== PI_AGENT_KIND || record.conversationFormat !== PI_CONVERSATION_FORMAT) return null;
    return readPiSessionCwdIdentity(record.conversationRef);
  }

  async controlSession(
    ownerKey: string,
    id: string,
    operation: "steer" | "follow-up" | "abort",
    text?: string,
    expectedRequestId?: string,
  ): Promise<"not-found" | import("./ports/index.js").ControlDecision> {
    const entry = await this.findEntry(ownerKey, id);
    if (!entry) return "not-found";
    const decision = operation === "steer"
      ? await entry.runtime.steer(text!)
      : operation === "follow-up"
        ? await entry.runtime.followUp(text!)
        : await entry.runtime.abort(expectedRequestId);
    return decision;
  }

  /** SSE transport uses the event bus, but ownership/runtime lookup remains application logic. */
  async getEntry(ownerKey: string, id: string): Promise<SessionEntry | null> {
    return this.findEntry(ownerKey, id);
  }

  /**
   * SSE viewer 只读入口（WP5D-3 P2）：只 registry.get（绝不创建 runtime/adapter，
   * 零 DB/文件副作用）。区分「记录不存在/越权」（HTTP 404）与「记录存在但无 runtime」
   * （HTTP 层返回稳定受控态 204：无可订阅的 live 事件流）。
   */
  async getExistingEntry(
    ownerKey: string,
    id: string,
  ): Promise<{ kind: "not-found" } | { kind: "no-runtime" } | { kind: "entry"; entry: SessionEntry }> {
    const record = await this.findOwned(ownerKey, id);
    if (!record) return { kind: "not-found" };
    const existing = this.deps.registry.get(id);
    if (!existing) return { kind: "no-runtime" };
    return { kind: "entry", entry: existing };
  }

  /**
   * 生成普通项目 ID：DEFAULT_PROJECT_ID 是 projects 表保留值（由 ensureDefaultProject 独占），
   * 普通项目生成到该值应跳过并重新生成，绝不可交给 repository.create 写入（避免暴露 500）；
   * 循环有界，防止损坏/测试用的 createId 恒返回保留值而死循环。
   */
  private nextProjectId(): string {
    for (let attempt = 0; ; attempt++) {
      const id = this.deps.createId();
      if (id !== DEFAULT_PROJECT_ID) return id;
      if (attempt >= MAX_ID_RETRIES) {
        throw new Error(
          `无法生成普通项目 ID：连续命中保留值 DEFAULT_PROJECT_ID（超过 ${MAX_ID_RETRIES + 1} 次）`,
        );
      }
    }
  }

  private defaultProject(): ProjectDto {
    return {
      id: DEFAULT_PROJECT_ID,
      name: this.deps.defaultProjectName ?? "默认项目",
      cwd: this.deps.defaultProjectCwd,
      isDefault: true,
    };
  }

  /**
   * 解析会话创建时要冻结的系统提示词：
   * - 覆盖（旧语义）：直接用字面量，绝不调用解析器、绝不追加默认提示词；
   * - 追加（宿主通用能力）：先用 SystemPromptPort 取项目完整提示词（Pi 默认或服务端整体
   *   提示词），再以固定分隔符追加插件片段；
   * - 均未提供：现有行为不变（解析器或服务端提示词，可能为 null）。
   *
   * 追加必须建立在「已知完整提示词」之上：解析器缺失且没有服务端提示词时 fail-closed，
   * 绝不静默退化为「只保留片段」（那等于丢掉整个 Pi 默认提示词）。
   * 二者互斥与非空已在 createSession 入口校验；结果整体冻结进 SessionRecord.systemPrompt，
   * 恢复会话（SessionConversationCoordinator）按快照字面量复用，不再重新解析或重复追加。
   */
  private async resolveSystemPrompt(
    projectCwd: string,
    input: { systemPromptOverride?: string; systemPromptAppend?: string },
  ): Promise<string | null> {
    if (input.systemPromptOverride !== undefined) return input.systemPromptOverride;
    const base = this.deps.systemPromptResolver
      ? await this.deps.systemPromptResolver.resolve(projectCwd)
      : (this.deps.systemPrompt ?? null);
    if (input.systemPromptAppend === undefined) return base;
    if (base === null || base === "") {
      throw new Error("无法解析系统提示词，不能执行会话系统提示词追加");
    }
    return `${base}${SYSTEM_PROMPT_APPEND_SEPARATOR}${input.systemPromptAppend}`;
  }

  private async resolveProject(ownerKey: string, projectId: string): Promise<ProjectDto | null> {
    const project = await this.deps.projects.get(projectId);
    if (!project) return null;
    if (projectId === DEFAULT_PROJECT_ID) {
      // 默认项目：共享（owner_key 空串），cwd/name 用运行时配置（表里存的是启动快照）
      return this.defaultProject();
    }
    return project.ownerKey === ownerKey ? toProjectDto(project) : null;
  }

  private async findOwned(ownerKey: string, id: string): Promise<SessionRecord | null> {
    const record = await this.deps.sessions.get(id);
    return record && record.ownerKey === ownerKey ? record : null;
  }

  private async findEntry(ownerKey: string, id: string): Promise<SessionEntry | null> {
    const record = await this.findOwned(ownerKey, id);
    if (!record) return null;
    try {
      return await this.deps.registry.getOrCreate(id, record.ownerKey);
    } catch (error) {
      if (error instanceof SessionDeletedError) return null;
      throw error;
    }
  }

  private async deleteRecord(record: SessionRecord): Promise<void> {
    // 会话删除与 file_operations enqueue 由 repository 在同一数据库事务中完成。
    await this.deps.sessions.delete(record.id);
    // 不在 DELETE 请求中 unlink；只清理进程内 runtime。
    await this.cleanupRuntime(record);
  }

  private async cleanupRuntime(record: SessionRecord): Promise<void> {
    await this.cleanupRuntimeById(record.id);
  }

  private async cleanupRuntimeById(sessionId: string): Promise<void> {
    await this.deps.registry.delete(sessionId);
  }
}

const RESERVED_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_RESERVED_SESSION_ID_LENGTH = 200;

/**
 * 校验宿主预约的会话 id：仅允许保守字符集与有限长度，避免把任意字符串写进主键
 * 或后续会话文件名。插件不能指定 id，此校验只作为宿主实现层的防御。
 */
function assertReservedSessionId(id: string): void {
  if (
    id.length === 0 ||
    id.length > MAX_RESERVED_SESSION_ID_LENGTH ||
    !RESERVED_SESSION_ID_PATTERN.test(id)
  ) {
    throw new Error("预留会话 id 非法（仅宿主可生成）");
  }
}

function toSessionDto(record: SessionRecord): SessionDto {
  const { agentKind: _agentKind, conversationFormat: _conversationFormat, conversationRef: _conversationRef, ...dto } = record;
  return dto;
}

function toProjectDto(project: { id: string; name: string; cwd: string }): ProjectDto {
  // 仅默认项目（defaultProject()）为 isDefault: true；此处均为 owner 私有项目。
  return { id: project.id, name: project.name, cwd: project.cwd, isDefault: false };
}
