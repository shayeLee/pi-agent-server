import { afterEach, describe, expect, it } from "vitest";
import { SessionService, MAX_ID_RETRIES, type CreateSessionResult } from "../../src/application/session-service.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { DuplicateIdError, ProjectForeignKeyError } from "../../src/application/ports/store-errors.js";
import type {
  ModelCatalogPort,
  ProjectRecord,
  ProjectStorePort,
  SessionRecord,
  SessionRecordPatch,
  SessionStorePort,
} from "../../src/application/ports/index.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";

class MemorySessions implements SessionStorePort {
  readonly records = new Map<string, SessionRecord>();
  /** 每次 create 尝试的 id（含冲突失败尝试），与应用层 createId 调用一一对应。 */
  readonly createAttempts: string[] = [];
  async create(record: SessionRecord) {
    this.createAttempts.push(record.id);
    this.records.set(record.id, { ...record });
  }
  async get(id: string) { return this.records.get(id) ?? null; }
  async listByOwner(ownerKey: string) { return [...this.records.values()].filter((r) => r.ownerKey === ownerKey); }
  async listByProject(ownerKey: string, projectId: string) {
    return [...this.records.values()].filter((r) => r.ownerKey === ownerKey && r.projectId === projectId);
  }
  async backfillSystemPrompt() { return 0; }
  async update(id: string, patch: SessionRecordPatch) {
    const current = this.records.get(id);
    if (!current) return false;
    this.records.set(id, { ...current, ...patch });
    return true;
  }
  async delete(id: string) { return this.records.delete(id); }
}

/** 模拟真实 SQLite repository 转换后的存储无关撞库错误。 */
function duplicateIdError(): DuplicateIdError {
  return new DuplicateIdError("主键/唯一约束冲突", {
    cause: Object.assign(new Error("UNIQUE constraint failed: rows.id"), { errcode: 1555 }),
  });
}

/** 前 conflicts 次 create 抛 DuplicateIdError（模拟撞库），其后转发内存实现。 */
class ConflictOnceSessions extends MemorySessions {
  private conflicts: number;
  constructor(conflicts = 1) {
    super();
    this.conflicts = conflicts;
  }
  override async create(record: SessionRecord): Promise<void> {
    if (this.conflicts > 0) {
      this.conflicts--;
      this.createAttempts.push(record.id);
      throw duplicateIdError();
    }
    await super.create(record);
  }
}

/** 每次都抛 DuplicateIdError（模拟持续撞库）。记录每次抛出的错误，便于断言超限时 cause 是最后一次。 */
class AlwaysConflictSessions extends MemorySessions {
  readonly thrownErrors: DuplicateIdError[] = [];
  override async create(record: SessionRecord): Promise<void> {
    this.createAttempts.push(record.id);
    const err = duplicateIdError();
    this.thrownErrors.push(err);
    throw err;
  }
}

/** 每次 create 都抛非 Duplicate 的普通错误（模拟存储层未知异常：不重试、不转换、原样抛出）。 */
class ThrowingSessions extends MemorySessions {
  override async create(record: SessionRecord): Promise<void> {
    this.createAttempts.push(record.id);
    throw new Error("存储层未知异常");
  }
}

/** 模拟真实 SQLite repository 转换后的外键约束失败（sessions.project_id → 项目在写入前被删除）。 */
class FkViolatingSessions extends MemorySessions {
  override async create(record: SessionRecord): Promise<void> {
    this.createAttempts.push(record.id);
    throw new ProjectForeignKeyError("会话外键约束冲突：sessions.project_id 引用的项目在写入前已被删除", {
      cause: Object.assign(new Error("FOREIGN KEY constraint failed"), { errcode: 787 }),
    });
  }
}

class MemoryProjects implements ProjectStorePort {
  readonly records = new Map<string, ProjectRecord>();
  /** 每次 create 尝试的 id（含冲突失败尝试）。 */
  readonly createAttempts: string[] = [];
  constructor(private readonly sessions: SessionStorePort) {}
  async create(record: ProjectRecord) {
    this.createAttempts.push(record.id);
    // 与真实 SQLite 实现一致：默认项目 id 由 ensureDefaultProject 独占
    if (record.id === DEFAULT_PROJECT_ID) throw new Error("默认项目 id 由 ensureDefaultProject 独占");
    this.records.set(record.id, { ...record });
  }
  async get(id: string) { return this.records.get(id) ?? null; }
  async listByOwner(ownerKey: string) { return [...this.records.values()].filter((r) => r.ownerKey === ownerKey); }
  async delete(id: string) {
    if (id === DEFAULT_PROJECT_ID) return false;
    return this.records.delete(id);
  }
  async deleteProjectWithSessions(projectId: string, sessionIds: string[]): Promise<void> {
    if (projectId === DEFAULT_PROJECT_ID) throw new Error("默认项目不可删除");
    for (const sessionId of sessionIds) await this.sessions.delete(sessionId);
    this.records.delete(projectId);
  }
  async ensureDefaultProject(record: ProjectRecord): Promise<void> {
    if (record.id !== DEFAULT_PROJECT_ID || record.ownerKey !== "") throw new Error("默认项目不变量违反");
    const existing = this.records.get(record.id);
    if (existing && existing.ownerKey !== "") throw new Error("默认项目既有记录异常");
    if (!this.records.has(record.id)) this.records.set(record.id, { ...record });
  }
}

/** 前 conflicts 次 create 抛 DuplicateIdError，其后转发内存实现。 */
class ConflictOnceProjects extends MemoryProjects {
  private conflicts: number;
  constructor(sessions: SessionStorePort, conflicts = 1) {
    super(sessions);
    this.conflicts = conflicts;
  }
  override async create(record: ProjectRecord): Promise<void> {
    if (this.conflicts > 0) {
      this.conflicts--;
      this.createAttempts.push(record.id);
      throw duplicateIdError();
    }
    await super.create(record);
  }
}

/** 每次都抛 DuplicateIdError（模拟持续撞库）。记录每次抛出的错误。 */
class AlwaysConflictProjects extends MemoryProjects {
  readonly thrownErrors: DuplicateIdError[] = [];
  constructor(sessions: SessionStorePort) {
    super(sessions);
  }
  override async create(record: ProjectRecord): Promise<void> {
    this.createAttempts.push(record.id);
    const err = duplicateIdError();
    this.thrownErrors.push(err);
    throw err;
  }
}

/** 每次 create 都抛非 Duplicate 的普通错误（模拟仓库守卫/未知异常）。 */
class ThrowingProjects extends MemoryProjects {
  constructor(sessions: SessionStorePort) {
    super(sessions);
  }
  override async create(record: ProjectRecord): Promise<void> {
    this.createAttempts.push(record.id);
    throw new Error("仓库守卫异常");
  }
}

class HangingAdapter extends MockAgentAdapter {
  override async prompt(text: string): Promise<void> {
    this.calls.push({ method: "prompt", text });
    await new Promise<void>(() => {});
  }
}

const registries: RuntimeRegistry[] = [];
afterEach(() => registries.splice(0).forEach((registry) => registry.dispose()));

function makeService(
  createAdapter: (id: string) => Promise<MockAgentAdapter> = async () => new MockAgentAdapter(),
  capabilityVersions?: Readonly<Record<string, number>>,
  modelCatalog: ModelCatalogPort = { getAvailable: async () => [], isAvailable: async () => true },
  // 具体 fake 类型（MemorySessions/MemoryProjects 及其子类）而非 Port 接口：
  // 断言需要直接访问可观测属性（createAttempts / records），二者均实现对应 Port 接口。
  sessions: MemorySessions = new MemorySessions(),
  createId: () => string = (() => { let nextId = 0; return () => `id-${++nextId}`; })(),
  projectsOverride?: MemoryProjects,
  now: () => number = () => 1234,
  systemPromptResolver?: (cwd: string) => Promise<string>,
) {
  const projects = projectsOverride ?? new MemoryProjects(sessions);
  // 默认项目落库（与真实 SQLite 实现的 ensureDefaultProject 对齐）：resolveProject 现按查库判定。
  void projects.ensureDefaultProject({ id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/workspace/default", ownerKey: "", createdAt: 0 });
  const adapters = new Map<string, MockAgentAdapter>();
  const registry = new RuntimeRegistry({
    concurrency: new ConcurrencyController({
      globalLimit: 20, perUserLimit: 2, perUserQueueLimit: 10, globalQueueLimit: 100, queueTimeoutMs: 300_000,
    }),
    createAdapter: async (id) => {
      const adapter = await createAdapter(id);
      adapters.set(id, adapter);
      return adapter;
    },
  });
  registries.push(registry);
  const removed: string[] = [];
  const service = new SessionService({
    sessions,
    projects,
    registry,
    defaultProjectCwd: "/workspace/default",
    capabilityVersions,
    modelCatalog,
    createId,
    now,
    systemPromptResolver: systemPromptResolver ? { resolve: systemPromptResolver } : undefined,
    removeSessionFile: async (path) => { removed.push(path); },
  });
  return { service, sessions, projects, adapters, removed };
}

function createdSession(result: CreateSessionResult): SessionRecord {
  if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
  return result.session as SessionRecord;
}

describe("SessionService", () => {
  it("创建会话时校验项目归属并写入默认项目配置", async () => {
    const { service, projects } = makeService();
    await projects.create({ id: "project-a", name: "A", cwd: "/workspace/a", ownerKey: "owner-a", createdAt: 1 });

    const created = createdSession(await service.createSession("owner-a", { title: "会话", projectId: "project-a" }));
    const denied = await service.createSession("owner-b", { projectId: "project-a" });

    expect(created).toMatchObject({ id: "id-1", ownerKey: "owner-a", projectId: "project-a", createdAt: 1234, systemPrompt: null });
    expect(denied).toEqual({ kind: "project-not-found" });
  });

  it("并发删除项目导致外键失败时 createSession 返回 project-not-found（而非 500）且不重试", async () => {
    const { service, sessions } = makeService(undefined, undefined, undefined, new FkViolatingSessions());
    // repository 已把 FK 787 转换为存储无关 ProjectForeignKeyError → 应映射为 project-not-found
    const result = await service.createSession("owner-a", {});
    expect(result).toEqual({ kind: "project-not-found" });
    expect(sessions.createAttempts).toEqual(["id-1"]); // 外键错误非重复 ID，不做重试
  });

  it("createProject 锁定保留值 DEFAULT_PROJECT_ID 时跳过并重新生成，不把保留 id 交给 repository.create", async () => {
    let next = 0;
    const createId = () => (++next === 1 ? DEFAULT_PROJECT_ID : `id-${next}`);
    const { service, projects } = makeService(undefined, undefined, undefined, undefined, createId);

    const created = await service.createProject("owner-a", { name: " 项目A ", cwd: " /var/a " });

    expect(created).toEqual({ id: "id-2", name: "项目A", cwd: "/var/a", isDefault: false });
    expect(projects.createAttempts).toEqual(["id-2"]); // 未调用 repository.create 处理保留 id
    // 默认项目记录保持 ensureDefaultProject 种子的样子（owner 为空、剩余普通项目名称未被覆盖）
    expect(projects.records.get(DEFAULT_PROJECT_ID)).toMatchObject({ ownerKey: "" });
    expect(projects.records.size).toBe(2); // 默认项目 + 新建项目
    expect(projects.records.get("id-2")).toMatchObject({ ownerKey: "owner-a", name: "项目A", cwd: "/var/a" });
  });

  it("项目 insert 首次 DuplicateIdError 自动用新 ID 重试并成功", async () => {
    const { service, projects } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      new ConflictOnceProjects(new MemorySessions()),
    );

    const created = await service.createProject("owner-a", { name: "项目B", cwd: "/var/b" });

    expect(created).toEqual({ id: "id-2", name: "项目B", cwd: "/var/b", isDefault: false });
    expect(projects.createAttempts).toEqual(["id-1", "id-2"]); // 首次冲突 → 新 ID 重试
    expect(projects.records.get("id-1")).toBeUndefined(); // 冲突尝试未落库
    expect(projects.records.get("id-2")).toMatchObject({ ownerKey: "owner-a" });
  });

  it("会话 insert 首次 DuplicateIdError 自动用新 ID 重试并成功，其余字段/语义正确", async () => {
    const { service, sessions } = makeService(undefined, undefined, undefined, new ConflictOnceSessions());

    const created = createdSession(await service.createSession("owner-a", {
      title: "会话T", projectId: DEFAULT_PROJECT_ID,
    }));

    expect(created.id).toBe("id-2");
    expect(created).toMatchObject({
      ownerKey: "owner-a",
      projectId: DEFAULT_PROJECT_ID,
      title: "会话T",
      createdAt: 1234,
      updatedAt: 1234,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
    });
    expect(sessions.createAttempts).toEqual(["id-1", "id-2"]); // 首次冲突 → 新 ID 重试
    expect(await sessions.get("id-2")).toMatchObject({ ownerKey: "owner-a", title: "会话T" });
  });

  it("会话连续 DuplicateIdError 达到重试上限时明确失败且不无限循环；cause 是最后一次 DuplicateIdError", async () => {
    const { service, sessions } = makeService(undefined, undefined, undefined, new AlwaysConflictSessions());

    const err = await service
      .createSession("owner-a", {})
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toMatch(/重试上限/);
    expect(sessions.createAttempts).toHaveLength(MAX_ID_RETRIES + 1); // 初次尝试 + 3 次重试
    // 超限错误必须保留最后一次 DuplicateIdError 作为 cause（不吞原始错误）
    const alwaysConflict = sessions as AlwaysConflictSessions;
    expect((err as Error).cause).toBe(alwaysConflict.thrownErrors[alwaysConflict.thrownErrors.length - 1]);
  });

  it("createSession 遇普通非 Duplicate 错误原样抛出且仅尝试一次（不重试、不吞掉）", async () => {
    const { service, sessions } = makeService(undefined, undefined, undefined, new ThrowingSessions());

    const err = await service
      .createSession("owner-a", {})
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe("存储层未知异常");
    expect(sessions.createAttempts).toEqual(["id-1"]); // 普通错误不重试
  });

  it("createSession 撞库重试时 now / systemPromptResolver / 能力快照只计算一次（重试循环外冻结）", async () => {
    let nowCalls = 0;
    let resolveCalls = 0;
    const now = () => ++nowCalls * 1000;
    const resolver = async () => {
      resolveCalls += 1;
      return "冻结的提示词";
    };
    const { service, sessions } = makeService(
      undefined,
      { "knowledge-qa": 1 },
      undefined,
      new ConflictOnceSessions(), // 首次撞库 → 第二次成功
      undefined,
      undefined,
      now,
      resolver,
    );

    const created = createdSession(await service.createSession("owner-a", {}));
    expect(created.id).toBe("id-2");
    expect(nowCalls).toBe(1); // 重试（id-2 尝试）不得重新取 now
    expect(resolveCalls).toBe(1); // 重试不得重新解析 systemPrompt（冻结于首次）
    const stored = await sessions.get("id-2");
    expect(stored?.systemPrompt).toBe("冻结的提示词");
    expect(stored?.capabilityVersions).toBe('{"knowledge-qa":1}'); // 能力快照冻结于首次，重试不重算
    expect(sessions.createAttempts).toEqual(["id-1", "id-2"]);
  });

  it("项目连续 DuplicateIdError 达到重试上限时明确失败且不无限循环；cause 是最后一次 DuplicateIdError", async () => {
    const { service, projects } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      new AlwaysConflictProjects(new MemorySessions()),
    );

    const err = await service
      .createProject("owner-a", { name: "A", cwd: "/a" })
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toMatch(/重试上限/);
    expect(projects.createAttempts).toHaveLength(MAX_ID_RETRIES + 1);
    // 超限错误必须保留最后一次（第 4 次尝试的）DuplicateIdError 作为 cause
    const alwaysConflict = projects as AlwaysConflictProjects;
    expect((err as Error).cause).toBe(alwaysConflict.thrownErrors[alwaysConflict.thrownErrors.length - 1]);
  });

  it("createId 连续命中 DEFAULT_PROJECT_ID 时有界失败，且 Project repository 零调用（保留值不进 repository）", async () => {
    // 恒返回保留值：nextProjectId 必须跳过并重新生成，循环有界失败；createAttempts 必须为空
    const { service, projects } = makeService(undefined, undefined, undefined, undefined, () => DEFAULT_PROJECT_ID);

    const err = await service
      .createProject("owner-a", { name: "A", cwd: "/a" })
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toMatch(/保留值 DEFAULT_PROJECT_ID/);
    expect(projects.createAttempts).toEqual([]); // 绝不把保留 id 交给 repository.create
  });

  it("createProject 遇非 Duplicate 错误原样抛出且仅尝试一次", async () => {
    const { service, projects } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      new ThrowingProjects(new MemorySessions()),
    );

    await expect(service.createProject("owner-a", { name: "A", cwd: "/a" }))
      .rejects.toThrow("仓库守卫异常");
    expect(projects.createAttempts).toEqual(["id-1"]); // 通用错误不重试、不吞掉
  });

  it("createProject 重试时 createdAt 仅计算一次（now 在重试循环外冻结，与 createSession 一致）", async () => {
    let nowCalls = 0;
    const now = () => ++nowCalls * 1000;
    const { service, projects } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      new ConflictOnceProjects(new MemorySessions()),
      now,
    );

    const created = await service.createProject("owner-a", { name: "R", cwd: "/r" });

    expect(created).toEqual({ id: "id-2", name: "R", cwd: "/r", isDefault: false });
    expect(nowCalls).toBe(1); // 重试（id-2 尝试）不得重新计算 createdAt
    expect(projects.records.get("id-2")?.createdAt).toBe(1000);
  });

  it("创建会话时冻结能力版本快照", async () => {
    const { service, sessions } = makeService(async () => new MockAgentAdapter(), { "knowledge-qa": 1 });
    const created = createdSession(await service.createSession("owner-a", {}));
    expect(await sessions.get(created.id)).toMatchObject({ capabilityVersions: '{"knowledge-qa":1}' });
  });

  it("对非归属用户隐藏会话", async () => {
    const { service, sessions } = makeService();
    const created = createdSession(await service.createSession("owner-a", { title: "私有" }));

    expect(await service.renameSession("owner-b", created.id, "越权")).toBeNull();
    expect(await service.deleteSession("owner-b", created.id)).toBe(false);
    expect(await service.exportSession("owner-b", created.id)).toBeNull();
    expect((await sessions.get(created.id))?.title).toBe("私有");
  });

  it("先切换 runtime 配置再持久化配置", async () => {
    const { service, adapters, sessions } = makeService();
    const created = createdSession(await service.createSession("owner-a", {}));

    const result = await service.configureSession("owner-a", created.id, {
      modelProvider: "openai", modelId: "gpt-5", thinkingLevel: "high",
    });

    expect(result).toMatchObject({ kind: "updated", session: { modelProvider: "openai", modelId: "gpt-5", thinkingLevel: "high" } });
    expect(adapters.get(created.id)?.calls).toEqual([
      { method: "setModel", provider: "openai", modelId: "gpt-5" },
      { method: "setThinkingLevel", level: "high" },
    ]);
    expect(await sessions.get(created.id)).toMatchObject({ modelProvider: "openai", modelId: "gpt-5", thinkingLevel: "high" });
  });

  it("createSession/configureSession 对不可用模型返回 invalid-model（不静默回退、不持久化）", async () => {
    const { service, adapters, sessions } = makeService(
      async () => new MockAgentAdapter(),
      undefined,
      { getAvailable: async () => [], isAvailable: async (p, id) => p === "openai" && id === "gpt-5" },
    );

    const badCreate = await service.createSession("owner-a", { modelProvider: "deepseek", modelId: "no-such" });
    expect(badCreate).toEqual({ kind: "invalid-model" });

    const created = createdSession(await service.createSession("owner-a", {}));
    const badConfig = await service.configureSession("owner-a", created.id, { modelProvider: "deepseek", modelId: "no-such" });
    expect(badConfig).toEqual({ kind: "invalid-model" });
    expect(adapters.get(created.id)?.calls).toEqual([]); // 未调用 setModel
    expect(await sessions.get(created.id)).toMatchObject({ modelProvider: null, modelId: null }); // 未持久化
  });

  it("catalog 可用性检查抛错时返回 model-check-failed（基础设施错误不误报为 400 不可用）", async () => {
    const { service } = makeService(
      async () => new MockAgentAdapter(),
      undefined,
      { getAvailable: async () => [], isAvailable: async () => { throw new Error("凭证读取失败"); } },
    );

    const created = await service.createSession("owner-a", { modelProvider: "deepseek", modelId: "v4-pro" });
    expect(created).toEqual({ kind: "model-check-failed" });
  });

  it("返回 runtime 的提交决策且不为无权会话创建 runtime", async () => {
    const { service, adapters } = makeService(async () => new HangingAdapter());
    const created = createdSession(await service.createSession("owner-a", {}));

    const first = await service.submitMessage("owner-a", created.id, { requestId: "r1", prompt: "first" });
    const second = await service.submitMessage("owner-a", created.id, { requestId: "r2", prompt: "second" });
    expect(first).toMatchObject({ found: true, decision: { kind: "run" } });
    expect(second).toMatchObject({ found: true, decision: { kind: "conflict" } });
    expect(await service.submitMessage("owner-b", created.id, { requestId: "r3", prompt: "hidden" })).toEqual({ found: false });
    expect(adapters.get(created.id)?.calls).toEqual([{ method: "prompt", text: "first" }]);
  });

  it("导出快照并在删除项目时级联删除会话与会话文件", async () => {
    const { service, sessions, projects, removed } = makeService();
    await projects.create({ id: "project-a", name: "A", cwd: "/workspace/a", ownerKey: "owner-a", createdAt: 1 });
    const first = createdSession(await service.createSession("owner-a", { projectId: "project-a" }));
    const second = createdSession(await service.createSession("owner-a", { projectId: "project-a" }));
    await sessions.update(first.id, { piSessionFile: "/tmp/first.jsonl" });
    await sessions.update(second.id, { piSessionFile: "/tmp/second.jsonl" });

    expect(await service.exportSession("owner-a", first.id)).toEqual({ messages: [], lastEventId: 0 });
    expect(await service.deleteProject("owner-a", "project-a")).toBe("deleted");
    expect(await projects.get("project-a")).toBeNull();
    expect(await sessions.get(first.id)).toBeNull();
    expect(await sessions.get(second.id)).toBeNull();
    expect(removed).toEqual(["/tmp/first.jsonl", "/tmp/second.jsonl"]);
  });
});
