import type {
  IdempotencyStorePort,
  ModelCatalogPort,
  ModelDescriptor,
  ProjectRecord,
  ProjectStorePort,
  SessionRecord,
  SessionRecordPatch,
  SessionStorePort,
  SystemPromptPort,
} from "./ports/index.js";
import { DEFAULT_PROJECT_ID } from "./ports/index.js";
import {
  RuntimeRegistry,
  SessionDeletedError,
  type SessionEntry,
} from "../runtime/runtime-registry.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SessionDto = Omit<SessionRecord, "piSessionFile">;
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
  /** 由 composition root 提供，避免 application 层依赖具体文件系统。 */
  removeSessionFile: (path: string) => Promise<void>;
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
  | { kind: "model-check-failed" };

export type SubmitResult =
  | { found: false }
  | {
      found: true;
      decision: Awaited<ReturnType<SessionEntry["runtime"]["submitMessage"]>>;
    };

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
    const record: ProjectRecord = {
      id: this.deps.createId(),
      name,
      cwd,
      ownerKey,
      createdAt: this.deps.now(),
    };
    await this.deps.projects.create(record);
    return toProjectDto(record);
  }

  /** @returns default / not-found / deleted, preserving HTTP's existing outcome distinctions. */
  async deleteProject(ownerKey: string, projectId: string): Promise<"default" | "not-found" | "deleted"> {
    if (projectId === DEFAULT_PROJECT_ID) return "default";
    const project = await this.deps.projects.get(projectId);
    if (!project || project.ownerKey !== ownerKey) return "not-found";

    // 墓碑：删除期间拒绝并发创建会话到本项目
    this.deletingProjects.add(projectId);
    try {
      const owned = await this.deps.sessions.listByProject(ownerKey, projectId);
      // 1. 逻辑删（SQLite 事务墓碑）：项目与会话要么全删、要么全保留
      await this.deps.projects.deleteProjectWithSessions(projectId, owned.map((r) => r.id));
      // 2. 物理清理：中止 runtime + 删文件（失败可重试/补偿，不阻塞逻辑删）
      for (const record of owned) {
        await this.cleanupRuntime(record);
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
    },
  ): Promise<CreateSessionResult> {
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
    const record: SessionRecord = {
      id: this.deps.createId(),
      ownerKey,
      projectId,
      title: input.title ?? "",
      createdAt: now,
      updatedAt: now,
      piSessionFile: null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      systemPrompt: this.deps.systemPromptResolver
        ? await this.deps.systemPromptResolver.resolve(project.cwd)
        : (this.deps.systemPrompt ?? null),
      capabilityVersions: this.deps.capabilityVersions
        ? JSON.stringify(this.deps.capabilityVersions)
        : null,
    };
    // 删除竞态二次防护：systemPrompt 解析期间项目可能被删（墓碑进行中或已删）
    if (this.deletingProjects.has(projectId) || !(await this.resolveProject(ownerKey, projectId))) {
      return { kind: "project-not-found" };
    }
    try {
      await this.deps.sessions.create(record);
    } catch (error) {
      // 并发删除项目导致 project_id 失效（SQLite 外键约束失败，787 = SQLITE_CONSTRAINT_FOREIGNKEY）：
      // 外键约束兑底，把竞态窗口的脏数据风险变成明确的 404「项目不存在」，而非 500。
      if (isForeignKeyConstraintError(error)) return { kind: "project-not-found" };
      throw error;
    }
    return { kind: "created", session: toSessionDto(record) };
  }

  async listSessions(ownerKey: string, projectId?: string): Promise<SessionDto[]> {
    const records = projectId
      ? await this.deps.sessions.listByProject(ownerKey, projectId)
      : await this.deps.sessions.listByOwner(ownerKey);
    return records.map(toSessionDto);
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
    input: { requestId: string; prompt: string; parentId?: string; images?: { mediaType: string; base64: string }[] },
  ): Promise<SubmitResult> {
    const entry = await this.findEntry(ownerKey, id);
    if (!entry) return { found: false };
    return {
      found: true,
      decision: await entry.runtime.submitMessage({ ...input, userId: ownerKey }),
    };
  }

  /**
   * 导出会话快照。契约：先读事件游标、再导出历史，导出期间新事件可能被重放，
   * 语义为「至少一次」——客户端需按 lastEventId 去重（避免重复消费）。
   */
  async exportSession(ownerKey: string, id: string): Promise<{ messages: unknown; lastEventId: number } | null> {
    const entry = await this.findEntry(ownerKey, id);
    if (!entry) return null;
    const lastEventId = entry.events.lastEventId;
    const messages = await entry.runtime.exportSession();
    return { messages, lastEventId };
  }

  async controlSession(
    ownerKey: string,
    id: string,
    operation: "steer" | "follow-up" | "abort",
    text?: string,
  ): Promise<"not-found" | "ok" | "conflict"> {
    const entry = await this.findEntry(ownerKey, id);
    if (!entry) return "not-found";
    const decision = operation === "steer"
      ? await entry.runtime.steer(text!)
      : operation === "follow-up"
        ? await entry.runtime.followUp(text!)
        : await entry.runtime.abort();
    return decision.kind;
  }

  /** SSE transport uses the event bus, but ownership/runtime lookup remains application logic. */
  async getEntry(ownerKey: string, id: string): Promise<SessionEntry | null> {
    return this.findEntry(ownerKey, id);
  }

  private defaultProject(): ProjectDto {
    return {
      id: DEFAULT_PROJECT_ID,
      name: this.deps.defaultProjectName ?? "默认项目",
      cwd: this.deps.defaultProjectCwd,
      isDefault: true,
    };
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
    // 1. 逻辑删（SQLite 墓碑）：会话对外不可见
    await this.deps.sessions.delete(record.id);
    // 2. 物理清理（失败可重试/补偿）
    await this.cleanupRuntime(record);
  }

  private async cleanupRuntime(record: SessionRecord): Promise<void> {
    await this.deps.registry.delete(record.id);
    if (record.piSessionFile) await this.deps.removeSessionFile(record.piSessionFile);
  }
}

function toSessionDto(record: SessionRecord): SessionDto {
  const { piSessionFile: _piSessionFile, ...dto } = record;
  return dto;
}

function toProjectDto(project: { id: string; name: string; cwd: string }): ProjectDto {
  // 仅默认项目（defaultProject()）为 isDefault: true；此处均为 owner 私有项目。
  return { id: project.id, name: project.name, cwd: project.cwd, isDefault: false };
}

/** 判断是否为 SQLite 外键约束失败（787 = SQLITE_CONSTRAINT_FOREIGNKEY 扩展错误码）。 */
function isForeignKeyConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    (error as { errcode?: unknown }).errcode === 787
  );
}
