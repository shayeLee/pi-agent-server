import { afterEach, describe, expect, it } from "vitest";
import { SessionService, MAX_ID_RETRIES, type CreateSessionResult } from "../../src/application/session-service.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { DuplicateIdError, ProjectForeignKeyError } from "../../src/application/ports/store-errors.js";
import { ConversationStorageRegistry } from "../../src/application/ports/index.js";
import type {
  ConversationReservationInput,
  IdempotencyStorePort,
  ModelCatalogPort,
  ProjectRecord,
  ProjectStorePort,
  SessionRecord,
  SessionRecordPatch,
  SessionStorePort,
} from "../../src/application/ports/index.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";
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
  async updateTitleIfEmpty(ownerKey: string, id: string, title: string, updatedAt: number) {
    const current = this.records.get(id);
    if (!current || current.ownerKey !== ownerKey) return null;
    if (current.title === "") {
      const updated = { ...current, title, updatedAt };
      this.records.set(id, updated);
      return updated;
    }
    return current;
  }
  async reserveConversation(id: string, reservation: ConversationReservationInput) {
    const current = this.records.get(id);
    if (!current || current.conversationRef !== null) return false;
    this.records.set(id, { ...current, conversationRef: reservation.conversationRef });
    return true;
  }
  async commitConversationReservation(id: string, expectedRef: string, actualRef: string) {
    const current = this.records.get(id);
    if (!current || current.conversationRef !== expectedRef) return false;
    this.records.set(id, { ...current, conversationRef: actualRef });
    return true;
  }
  async releaseConversationReservation(id: string, expectedRef: string) {
    const current = this.records.get(id);
    if (!current || current.conversationRef !== expectedRef) return false;
    this.records.set(id, { ...current, conversationRef: null });
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

/** prompt 挂起直到 finishStream() 释放的可控 adapter；事件由测试手动 emit。 */
class ManualPromptAdapter extends MockAgentAdapter {
  private release: (() => void) | undefined;

  override async prompt(text: string): Promise<void> {
    this.calls.push({ method: "prompt", text });
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  finishStream(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }
}

/**
 * 可暂停 `get` 的幂等仓储：用它在 runTurn 的 submit 异步窗口内制造旧请求终态，
 * 从而稳定复现“旧 event 串 request”的竞态。
 */
class DeferredIdempotencyRepo implements IdempotencyStorePort {
  private readonly records = new Map<string, unknown>();
  private readonly held = new Map<string, { promise: Promise<unknown | null>; resolve: (value: unknown | null) => void }>();

  hold(sessionId: string, requestId: string): void {
    const key = `${sessionId}:${requestId}`;
    let resolve!: (value: unknown | null) => void;
    const promise = new Promise<unknown | null>((r) => {
      resolve = r;
    });
    this.held.set(key, { promise, resolve });
  }

  release(sessionId: string, requestId: string, value: unknown | null = null): void {
    const key = `${sessionId}:${requestId}`;
    const entry = this.held.get(key);
    this.held.delete(key);
    entry?.resolve(value);
  }

  async get(sessionId: string, requestId: string): Promise<unknown | null> {
    const key = `${sessionId}:${requestId}`;
    const entry = this.held.get(key);
    if (entry) return entry.promise;
    return this.records.get(key) ?? null;
  }

  async put(sessionId: string, requestId: string, result: unknown): Promise<void> {
    this.records.set(`${sessionId}:${requestId}`, result);
  }

  async prune(): Promise<number> {
    return 0;
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
  conversationStorage?: ConversationStorageRegistry,
  idempotencyRepo?: IdempotencyStorePort,
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
    ...(idempotencyRepo !== undefined ? { idempotencyRepo } : {}),
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
    conversationStorage,
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

  it("指定/预约 sessionId：严格使用该 id 创建，不消耗 createId", async () => {
    const { service, sessions } = makeService();
    const created = createdSession(
      await service.createSession("owner-a", { sessionId: "resv-1", title: "预约会话" }),
    );
    expect(created.id).toBe("resv-1");
    expect(sessions.createAttempts).toEqual(["resv-1"]);
    expect(await sessions.get("resv-1")).toMatchObject({ ownerKey: "owner-a", title: "预约会话" });
  });

  it("指定/预约 sessionId 撞库返回 id-conflict，绝不换 id 重试（预约语义不可破坏）", async () => {
    const { service, sessions } = makeService(undefined, undefined, undefined, new AlwaysConflictSessions());
    const result = await service.createSession("owner-a", { sessionId: "resv-2" });
    expect(result).toEqual({ kind: "id-conflict" });
    expect(sessions.createAttempts).toEqual(["resv-2"]);
  });

  it("指定/预约 sessionId 非法时拒绝，且不触达存储", async () => {
    const { service, sessions } = makeService();
    for (const bad of ["", " ", "a b", "a/b", "..", "-leading", "x".repeat(201)]) {
      await expect(service.createSession("owner-a", { sessionId: bad })).rejects.toThrow(/预留会话 id 非法/);
    }
    expect(sessions.createAttempts).toEqual([]);
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

  it("createSession 使用非空 systemPromptOverride 冻结提示词且不调用 resolver", async () => {
    let resolveCalls = 0;
    const resolver = async () => {
      resolveCalls += 1;
      return "resolver 提示词";
    };
    const { service, sessions } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, resolver,
    );

    const created = createdSession(await service.createSession("owner-a", {
      systemPromptOverride: "内部 profile 提示词",
    }));

    expect(created.systemPrompt).toBe("内部 profile 提示词");
    expect((await sessions.get(created.id))?.systemPrompt).toBe("内部 profile 提示词");
    expect(resolveCalls).toBe(0);
  });

  it("getSystemPrompt 只返回 owner 自己在创建时冻结的提示词", async () => {
    const { service } = makeService();
    const owned = createdSession(await service.createSession("owner-a", {
      systemPromptOverride: "owner-a 的冻结提示词",
    }));
    const other = createdSession(await service.createSession("owner-b", {
      systemPromptOverride: "owner-b 的冻结提示词",
    }));

    expect(await service.getSystemPrompt("owner-a", owned.id)).toBe("owner-a 的冻结提示词");
    // 越权和不存在统一折叠为 null，既不泄漏其他 owner 的提示词，也不泄漏会话存在性。
    expect(await service.getSystemPrompt("owner-a", other.id)).toBeNull();
    expect(await service.getSystemPrompt("owner-a", "missing")).toBeNull();
  });

  it("createSession 拒绝空字符串 systemPromptOverride", async () => {
    const { service } = makeService();

    await expect(service.createSession("owner-a", {
      systemPromptOverride: "",
    })).rejects.toThrow("会话系统提示词覆盖不能为空");
  });

  it("createSession 追加 systemPromptAppend：先取 resolver 的完整提示词，再以空行分隔安全追加并冻结", async () => {
    const resolverCwds: string[] = [];
    const resolver = async (cwd: string) => {
      resolverCwds.push(cwd);
      return "Pi 默认完整提示词";
    };
    const { service, sessions } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, resolver,
    );

    const created = createdSession(await service.createSession("owner-a", {
      systemPromptAppend: "仅只读查询。",
    }));

    // 追加语义：默认提示词完整保留在最前，片段附在其后（与 Pi 原生 append 一致的空行分隔）。
    expect(created.systemPrompt).toBe("Pi 默认完整提示词\n\n仅只读查询。");
    expect((await sessions.get(created.id))?.systemPrompt).toBe("Pi 默认完整提示词\n\n仅只读查询。");
    expect(resolverCwds).toEqual(["/workspace/default"]);
  });

  it("createSession 追加 systemPromptAppend 时不修改服务端默认提示词配置（Pi 默认 prompt 不变）", async () => {
    const { service, sessions } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, async () => "Pi 默认完整提示词",
    );

    const plain = createdSession(await service.createSession("owner-a", {}));
    const appended = createdSession(await service.createSession("owner-a", {
      systemPromptAppend: "插件片段",
    }));

    expect((await sessions.get(plain.id))?.systemPrompt).toBe("Pi 默认完整提示词");
    expect((await sessions.get(appended.id))?.systemPrompt).toBe("Pi 默认完整提示词\n\n插件片段");
  });

  it("createSession 在无解析器且无服务端提示词时对 systemPromptAppend fail-closed（不静默退化为只留片段）", async () => {
    const { service, sessions } = makeService();

    await expect(service.createSession("owner-a", { systemPromptAppend: "插件片段" }))
      .rejects.toThrow("无法解析系统提示词，不能执行会话系统提示词追加");
    expect(sessions.createAttempts).toEqual([]); // 未写入任何会话
  });

  it("createSession 无解析器但注入了服务端整体提示词时，systemPromptAppend 追加到它之后", async () => {
    // 直接组装 SessionService：makeService 不暴露 systemPrompt 配置入口，而这条路径
    // 正是 `PI_SYSTEM_PROMPT` 与追加来源共存时的行为。
    const sessions = new MemorySessions();
    const projects = new MemoryProjects(sessions);
    await projects.ensureDefaultProject({
      id: DEFAULT_PROJECT_ID, name: "默认项目", cwd: "/workspace/default", ownerKey: "", createdAt: 0,
    });
    const registry = new RuntimeRegistry({
      concurrency: new ConcurrencyController({
        globalLimit: 20, perUserLimit: 2, perUserQueueLimit: 10, globalQueueLimit: 100, queueTimeoutMs: 300_000,
      }),
      createAdapter: async () => new MockAgentAdapter(),
    });
    registries.push(registry);
    const service = new SessionService({
      sessions,
      projects,
      registry,
      defaultProjectCwd: "/workspace/default",
      systemPrompt: "服务端整体提示词",
      createId: () => "id-1",
      now: () => 1234,
    });

    const created = createdSession(await service.createSession("owner-a", { systemPromptAppend: "插件片段" }));

    expect((await sessions.get(created.id))?.systemPrompt).toBe("服务端整体提示词\n\n插件片段");
  });

  it("createSession 拒绝空白 systemPromptAppend", async () => {
    const { service } = makeService();

    await expect(service.createSession("owner-a", { systemPromptAppend: "  " }))
      .rejects.toThrow("会话系统提示词追加不能为空");
  });

  it("createSession 拒绝同时提供 systemPromptOverride 与 systemPromptAppend（二者互斥）", async () => {
    let resolveCalls = 0;
    const resolver = async () => {
      resolveCalls += 1;
      return "解析结果";
    };
    const { service, sessions } = makeService(
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, resolver,
    );

    await expect(service.createSession("owner-a", {
      systemPromptOverride: "覆盖",
      systemPromptAppend: "追加",
    })).rejects.toThrow("会话系统提示词覆盖与追加不能同时提供");
    expect(resolveCalls).toBe(0);
    expect(sessions.createAttempts).toEqual([]); // 互斥校验先于任何写入
  });

  it("createSession 追加 systemPromptAppend 撞库重试时 resolver 只调用一次（快照冻结于首次）", async () => {
    let resolveCalls = 0;
    const resolver = async () => {
      resolveCalls += 1;
      return "冻结的默认提示词";
    };
    const { service, sessions } = makeService(
      undefined, undefined, undefined,
      new ConflictOnceSessions(),
      undefined, undefined, undefined, resolver,
    );

    const created = createdSession(await service.createSession("owner-a", { systemPromptAppend: "片段" }));

    expect(created.id).toBe("id-2");
    expect(resolveCalls).toBe(1);
    expect((await sessions.get("id-2"))?.systemPrompt).toBe("冻结的默认提示词\n\n片段");
    expect(sessions.createAttempts).toEqual(["id-1", "id-2"]);
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

  it("onlyIfEmpty 原子更新空标题，保留已有自定义标题并隐藏其他 owner", async () => {
    const { service, sessions } = makeService(undefined, undefined, undefined, undefined, undefined, undefined, () => 500);
    const created = createdSession(await service.createSession("owner-a", {}));

    expect(await service.renameSession("owner-a", created.id, "自动标题", { onlyIfEmpty: true }))
      .toMatchObject({ title: "自动标题" });
    await service.renameSession("owner-a", created.id, "用户标题");
    expect(await service.renameSession("owner-a", created.id, "不应覆盖", { onlyIfEmpty: true }))
      .toMatchObject({ title: "用户标题" });
    expect(await service.renameSession("owner-b", created.id, "越权", { onlyIfEmpty: true })).toBeNull();
    expect((await sessions.get(created.id))?.title).toBe("用户标题");
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

  it("导出快照并在删除项目时级联删除会话且只由 outbox 负责文件清理", async () => {
    const readCalls: string[] = [];
    const { service, sessions, projects, removed } = makeService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // 只读存储（有引用但未实例化的会话经它零写导出，绝不实例化 runtime）。
      (() => {
        const storage = new ConversationStorageRegistry();
        storage.register({
          agentKind: "pi",
          conversationFormat: "pi-jsonl-v3",
          readExport: async (conversation) => { readCalls.push(conversation.conversationRef!); return []; },
          planCleanup: () => null,
        });
        return storage;
      })(),
    );
    await projects.create({ id: "project-a", name: "A", cwd: "/workspace/a", ownerKey: "owner-a", createdAt: 1 });
    const first = createdSession(await service.createSession("owner-a", { projectId: "project-a" }));
    const second = createdSession(await service.createSession("owner-a", { projectId: "project-a" }));
    await sessions.reserveConversation(first.id, { conversationRef: "/tmp/first.jsonl", tombstoneOperationKey: "tombstone-first" });
    await sessions.reserveConversation(second.id, { conversationRef: "/tmp/second.jsonl", tombstoneOperationKey: "tombstone-second" });

    // 有文件但无 runtime：只经只读解析口导出（同一投影），不创建 adapter、不写 DB/文件。
    expect(await service.exportSession("owner-a", first.id)).toEqual({ messages: [], timeline: [], lastEventId: 0 });
    expect(readCalls).toEqual(["/tmp/first.jsonl"]);
    expect(await service.deleteProject("owner-a", "project-a")).toBe("deleted");
    expect(await projects.get("project-a")).toBeNull();
    expect(await sessions.get(first.id)).toBeNull();
    expect(await sessions.get(second.id)).toBeNull();
    // WP4A：服务层不得直接 unlink；文件副作用由持久 file_operations outbox 处理。
    expect(removed).toEqual([]);
  });

  describe("runTurn", () => {
    function events(text: string, stopReason = "stop"): AgentSdkEvent[] {
      return [
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
        },
        { type: "agent_end", messages: [{ role: "assistant", stopReason }] },
      ];
    }

    it("完成一轮并返回助手文本，且绑定 owner/session/requestId", async () => {
      const adapter = new MockAgentAdapter(events("你好"));
      const { service } = makeService(async () => adapter);
      const session = createdSession(await service.createSession("owner-a", { title: "t" }));

      const result = await service.runTurn("owner-a", {
        sessionId: session.id,
        requestId: "req-1",
        prompt: "生成原型",
      });
      expect(result).toEqual({ status: "completed", text: "你好" });
      expect(adapter.calls).toEqual([{ method: "prompt", text: "生成原型" }]);

      // 越权/未知 owner 返回 null，绝不触达 adapter。
      expect(
        await service.runTurn("owner-b", { sessionId: session.id, requestId: "req-2", prompt: "x" }),
      ).toBeNull();
      expect(await service.runTurn("owner-a", { sessionId: "missing", requestId: "req-3", prompt: "x" })).toBeNull();
    });

    it("错误终态返回 error，abort 返回 aborted", async () => {
      const errorAdapter = new MockAgentAdapter([
        { type: "agent_start" },
        { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "模型失败" }] },
      ]);
      const { service: errorService } = makeService(async () => errorAdapter);
      const errorSession = createdSession(await errorService.createSession("owner-a", {}));
      expect(
        await errorService.runTurn("owner-a", { sessionId: errorSession.id, requestId: "e", prompt: "p" }),
      ).toEqual({ status: "error", message: "模型失败" });

      const abortAdapter = new MockAgentAdapter([
        { type: "agent_start" },
        { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] },
      ]);
      const { service: abortService } = makeService(async () => abortAdapter);
      const abortSession = createdSession(await abortService.createSession("owner-a", {}));
      expect(
        await abortService.runTurn("owner-a", { sessionId: abortSession.id, requestId: "a", prompt: "p" }),
      ).toEqual({ status: "aborted" });
    });

    it("session 正忙时返回 busy 且不触发模型", async () => {
      const hanging = new HangingAdapter();
      const { service } = makeService(async () => hanging);
      const session = createdSession(await service.createSession("owner-a", {}));
      // 先占用会话（流式任务不结束）。
      const submitted = await service.submitMessage("owner-a", session.id, {
        requestId: "hold",
        prompt: "占用",
      });
      expect(submitted).toMatchObject({ found: true, decision: { kind: "run" } });

      const result = await service.runTurn("owner-a", {
        sessionId: session.id,
        requestId: "busy-probe",
        prompt: "不应执行",
      });
      expect(result).toEqual({ status: "busy" });
      expect(hanging.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    });

    it("同一 requestId 重放不再执行模型（无文本可重放）", async () => {
      let prompts = 0;
      const adapter = new MockAgentAdapter(events("结果"));
      const { service } = makeService(async () => {
        prompts += 1;
        return adapter;
      });
      const session = createdSession(await service.createSession("owner-a", {}));
      const first = await service.runTurn("owner-a", { sessionId: session.id, requestId: "same", prompt: "p" });
      expect(first).toEqual({ status: "completed", text: "结果" });
      const replay = await service.runTurn("owner-a", { sessionId: session.id, requestId: "same", prompt: "p" });
      expect(replay).toMatchObject({ status: "error" });
      expect(prompts).toBe(1);
    });

    it("竞态：submit 异步窗口内旧请求的 text/终态绝不串入新 requestId 的 runTurn", async () => {
      // 旧实现订阅 session 级事件总线：在 submit 的 async 前，旧请求的 text_delta/completed
      // 会被误归属为新 runTurn 的结果。新实现按 requestId（currentKey）专属累计与结算。
      const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
      const repo = new DeferredIdempotencyRepo();
      const adapter = new ManualPromptAdapter();
      const { service } = makeService(
        async () => adapter,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        repo,
      );
      const session = createdSession(await service.createSession("owner-a", {}));

      // 旧任务进入 streaming（prompt 挂起）。
      await service.submitMessage("owner-a", session.id, { requestId: "old", prompt: "旧" });

      // 新 runTurn 的 submit 在幂等查询处暂停，制造稳定、可观测的异步窗口。
      repo.hold(session.id, "new");
      const pending = service.runTurn("owner-a", { sessionId: session.id, requestId: "new", prompt: "新" });
      await tick();

      // 窗口内到达旧请求的文本与终态（session 级事件）。
      adapter.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "OLD" },
      });
      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream(); // 旧任务 settle → 合成 session 级 completed
      await tick();

      // 放行新请求的幂等查询：session 已空闲，新任务启动。
      repo.release(session.id, "new");
      await tick();
      adapter.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "NEW" },
      });
      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream();

      const result = await pending;
      expect(result).toEqual({ status: "completed", text: "NEW" });
      expect(adapter.calls.filter((call) => call.method === "prompt")).toEqual([
        { method: "prompt", text: "旧" },
        { method: "prompt", text: "新" },
      ]);
    });

    it("助手文本超过上限时中止本轮并返回 error", async () => {
      const huge = "x".repeat(256 * 1024 + 1);
      const adapter = new MockAgentAdapter(events(huge));
      const { service } = makeService(async () => adapter);
      const session = createdSession(await service.createSession("owner-a", {}));
      const result = await service.runTurn("owner-a", { sessionId: session.id, requestId: "big", prompt: "p" });
      expect(result).toEqual({ status: "error", message: "助手输出超过宿主上限" });
      expect(adapter.aborted).toBe(true);
    });
  });
});
