import { afterEach, describe, expect, it } from "vitest";
import { SessionService, type CreateSessionResult } from "../../src/application/session-service.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
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
  async create(record: SessionRecord) { this.records.set(record.id, { ...record }); }
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

/** 模拟并发删除项目导致的外键约束失败（787 = SQLITE_CONSTRAINT_FOREIGNKEY）。 */
class FkViolatingSessions extends MemorySessions {
  override async create(_record: SessionRecord): Promise<void> {
    throw Object.assign(new Error("FOREIGN KEY constraint failed"), { errcode: 787 });
  }
}

class MemoryProjects implements ProjectStorePort {
  readonly records = new Map<string, ProjectRecord>();
  constructor(private readonly sessions: SessionStorePort) {}
  async create(record: ProjectRecord) {
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
  sessions: SessionStorePort = new MemorySessions(),
) {
  const projects = new MemoryProjects(sessions);
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
  let nextId = 0;
  const removed: string[] = [];
  const service = new SessionService({
    sessions,
    projects,
    registry,
    defaultProjectCwd: "/workspace/default",
    capabilityVersions,
    modelCatalog,
    createId: () => `id-${++nextId}`,
    now: () => 1234,
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

  it("并发删除项目导致外键失败时 createSession 返回 project-not-found（而非 500）", async () => {
    const { service } = makeService(undefined, undefined, undefined, new FkViolatingSessions());
    // sessions.create 抛外键约束失败（模拟并发删除竞态）→ 应映射为 project-not-found
    const result = await service.createSession("owner-a", {});
    expect(result).toEqual({ kind: "project-not-found" });
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
