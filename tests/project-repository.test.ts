import { afterEach, describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { identityKey } from "../src/core/user-identity.js";
import type { ProjectRecord } from "../src/application/ports/project-store-port.js";
import type { SessionRecord } from "../src/application/ports/session-store-port.js";
import { KyselyProjectRepository } from "../src/storage/kysely-project-repository.js";
import { DEFAULT_PROJECT_ID } from "../src/application/ports/project-store-port.js";
import { DuplicateIdError } from "../src/application/ports/store-errors.js";
import { initStorage, makeInitializedMemoryDb, type SqliteTestStorage } from "./helpers/sqlite.js";

function makeDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

// M2 资源所有权：所有已初始化 fixture 在 afterEach 按真实所有权关闭（统一 Kysely destroy close，
// 不直接 db.close() 绕过 Kysely）。
const openStorages: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (openStorages.length) await openStorages.pop()!.close();
});

async function makeRepo(db: DatabaseSync = makeDb()): Promise<KyselyProjectRepository> {
  const storage = await initStorage(db);
  openStorages.push(storage);
  return storage.projects;
}

async function trackedInitializedMemoryDb(): Promise<SqliteTestStorage> {
  const storage = await makeInitializedMemoryDb();
  openStorages.push(storage);
  return storage;
}

function makeRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p-" + Math.random().toString(36).slice(2),
    name: "测试项目",
    cwd: "/path/to/repo",
    ownerKey: identityKey({ kind: "ip", ip: "10.0.0.1" }),
    createdAt: 1000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-" + Math.random().toString(36).slice(2),
    ownerKey: identityKey({ kind: "ip", ip: "10.0.0.1" }),
    projectId: "p1",
    title: "",
    createdAt: 1,
    updatedAt: 1,
    piSessionFile: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
    ...overrides,
  };
}

describe("项目索引存储（多项目，SQLite 实现）", () => {
  describe("create / get", () => {
    it("create 后 get 返回完整记录", async () => {
      const repo = await makeRepo();
      const rec = makeRecord();
      await repo.create(rec);
      expect(await repo.get(rec.id)).toEqual(rec);
    });

    it("get 不存在的项目返回 null", async () => {
      const repo = await makeRepo();
      expect(await repo.get("no-such-id")).toBeNull();
    });

    it("create 撞主键（重复 id）时转换为存储无关的 DuplicateIdError 并保留原始 cause", async () => {
      const repo = await makeRepo();
      const rec = makeRecord({ id: "p-dup" });
      await repo.create(rec);

      const err = await repo.create(rec).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(DuplicateIdError);
      expect((err as DuplicateIdError).message).toMatch(/主键/);
      // 原始 SQLite 约束错误保留在 cause（1555 = SQLITE_CONSTRAINT_PRIMARYKEY）
      expect((((err as DuplicateIdError).cause) as { errcode?: number }).errcode).toBe(1555);
    });

    it("非 id 列的 2067 唯一约束冲突原样抛出（不映射为 DuplicateIdError）", async () => {
      const { db, projects: repo } = await trackedInitializedMemoryDb();
      // 在已有非 id 列上创建唯一索引，模拟未来新增唯一约束
      db.exec("CREATE UNIQUE INDEX idx_test_owner ON projects(owner_key)");
      const owner = identityKey({ kind: "ip", ip: "10.99.99.99" });
      await repo.create(makeRecord({ id: "p-nid1", ownerKey: owner }));

      const err = await repo
        .create(makeRecord({ id: "p-nid2", ownerKey: owner }))
        .then(() => null, (e: unknown) => e);
      // 非 id 唯一约束错误必须原样抛出，不映射为 DuplicateIdError
      expect(err).toBeDefined();
      expect(err).not.toBeInstanceOf(DuplicateIdError);
      expect((err as { errcode?: number }).errcode).toBe(2067);
      expect((err as Error).message).toMatch(/projects\.owner_key/);
    });

    it("复合唯一索引（owner_key + name）冲突原样抛出（含逗号的 2067 消息不误转）", async () => {
      const { db, projects: repo } = await trackedInitializedMemoryDb();
      // 复合唯一约束：冲突消息为 "UNIQUE constraint failed: projects.owner_key, projects.name"
      db.exec("CREATE UNIQUE INDEX idx_test_owner_name ON projects(owner_key, name)");
      const owner = identityKey({ kind: "ip", ip: "10.99.99.99" });
      await repo.create(makeRecord({ id: "p-c1", ownerKey: owner, name: "同名" }));

      const err = await repo
        .create(makeRecord({ id: "p-c2", ownerKey: owner, name: "同名" }))
        .then(() => null, (e: unknown) => e);
      expect(err).toBeDefined();
      expect(err).not.toBeInstanceOf(DuplicateIdError);
      expect((err as { errcode?: number }).errcode).toBe(2067);
      expect((err as Error).message).toMatch(/projects\.owner_key,\s*projects\.name/);
    });
  });

  describe("listByOwner", () => {
    it("只返回该 owner 的项目，按 createdAt 降序", async () => {
      const repo = await makeRepo();
      const owner = identityKey({ kind: "ip", ip: "10.0.0.1" });
      const a = makeRecord({ id: "p1", ownerKey: owner, createdAt: 1000 });
      const b = makeRecord({ id: "p2", ownerKey: owner, createdAt: 3000 });
      const other = makeRecord({
        id: "p3",
        ownerKey: identityKey({ kind: "ip", ip: "10.0.0.2" }),
        createdAt: 9999,
      });
      for (const rec of [a, b, other]) await repo.create(rec);

      expect(await repo.listByOwner(owner)).toEqual([b, a]);
    });
  });

  describe("delete", () => {
    it("delete 返回 true 且 get 变 null", async () => {
      const repo = await makeRepo();
      const rec = makeRecord();
      await repo.create(rec);

      expect(await repo.delete(rec.id)).toBe(true);
      expect(await repo.get(rec.id)).toBeNull();
    });

    it("delete 不存在的项目返回 false", async () => {
      const repo = await makeRepo();
      expect(await repo.delete("no-such-id")).toBe(false);
    });
  });

  describe("deleteProjectWithSessions（事务逻辑删）", () => {
    it("同一事务删除项目及其所有会话", async () => {
      const storage = await trackedInitializedMemoryDb();
      const repo = storage.projects;
      const sessions = storage.sessions;

      await repo.create(makeRecord({ id: "p1" }));
      const s1 = makeSession({ id: "s1" });
      const s2 = makeSession({ id: "s2" });
      await sessions.create(s1);
      await sessions.create(s2);

      await repo.deleteProjectWithSessions("p1", ["s1", "s2"]);

      expect(await repo.get("p1")).toBeNull();
      expect(await sessions.get("s1")).toBeNull();
      expect(await sessions.get("s2")).toBeNull();
    });

    it("会话 id 列表为空时仍删除项目", async () => {
      const storage = await trackedInitializedMemoryDb();
      const repo = storage.projects;
      await repo.create(makeRecord({ id: "p1" }));

      await repo.deleteProjectWithSessions("p1", []);
      expect(await repo.get("p1")).toBeNull();
    });

    it("外键 CASCADE：直接删项目自动级联删其会话（数据库层兑底，无需显式删 sessions）", async () => {
      const storage = await trackedInitializedMemoryDb();
      const repo = storage.projects;
      const sessions = storage.sessions;
      await repo.create(makeRecord({ id: "p1" }));
      await sessions.create(makeSession({ id: "s1" }));
      await sessions.create(makeSession({ id: "s2" }));

      // 绕过 deleteProjectWithSessions，直接单表删除项目：外键 ON DELETE CASCADE 应自动删 sessions
      await repo.delete("p1");

      expect(await repo.get("p1")).toBeNull();
      expect(await sessions.get("s1")).toBeNull();
      expect(await sessions.get("s2")).toBeNull();
    });
  });

  describe("owner 隔离", () => {
    it("不同 owner 的项目互不串扰", async () => {
      const repo = await makeRepo();
      const ownerA = identityKey({ kind: "ip", ip: "10.1.1.1" });
      const ownerB = identityKey({ kind: "ip", ip: "10.0.0.9" });
      await repo.create(makeRecord({ id: "a1", ownerKey: ownerA, name: "A 项目" }));
      await repo.create(makeRecord({ id: "b1", ownerKey: ownerB, name: "B 项目" }));

      expect(await repo.listByOwner(ownerA)).toHaveLength(1);
      expect((await repo.listByOwner(ownerA))[0]?.name).toBe("A 项目");
      expect((await repo.listByOwner(ownerB))[0]?.name).toBe("B 项目");
    });
  });

  describe("默认项目不变量（保留 id 由 ensureDefaultProject 独占）", () => {
    const defaultRecord = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
      id: DEFAULT_PROJECT_ID,
      name: "默认项目",
      cwd: "/tmp/default",
      ownerKey: "",
      createdAt: 0,
      ...overrides,
    });

    it("ensureDefaultProject 拒绝非 default id 或非空 owner", async () => {
      const repo = await makeRepo();
      await expect(repo.ensureDefaultProject(defaultRecord({ id: "not-default" }))).rejects.toThrow(/默认项目 id/);
      await expect(repo.ensureDefaultProject(defaultRecord({ ownerKey: "owner-x" }))).rejects.toThrow(/空 owner/);
    });

    it("ensureDefaultProject 对既有异常 owner 行显式失败（而非静默 IGNORE）", async () => {
      const { db, projects: repo } = await trackedInitializedMemoryDb();
      // 把默认行 owner 改成异常（模拟历史/直接写入），再触发 ensureDefaultProject
      db.prepare("UPDATE projects SET owner_key = 'owner-x' WHERE id = ?").run(DEFAULT_PROJECT_ID);
      await expect(repo.ensureDefaultProject(defaultRecord())).rejects.toThrow(/owner 非空/);
    });

    it("create 拒绝写入 default id（无论 owner 是否为空）", async () => {
      const repo = await makeRepo();
      await expect(repo.create(defaultRecord({ ownerKey: "owner-x" }))).rejects.toThrow(/独占/);
      await expect(repo.create(defaultRecord({ ownerKey: "" }))).rejects.toThrow(/独占/);
    });

    it("delete 拒绝删除 default（返回 false，且不触发 CASCADE）", async () => {
      const storage = await trackedInitializedMemoryDb();
      const repo = storage.projects;
      const sessions = storage.sessions;
      await repo.ensureDefaultProject(defaultRecord());
      await sessions.create({
        id: "s-default", ownerKey: "owner", projectId: DEFAULT_PROJECT_ID, title: "默认会话",
        createdAt: 1, updatedAt: 1, piSessionFile: null, modelProvider: null,
        modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
      });

      expect(await repo.delete(DEFAULT_PROJECT_ID)).toBe(false);
      expect(await repo.get(DEFAULT_PROJECT_ID)).not.toBeNull(); // 项目仍在
      expect(await sessions.get("s-default")).not.toBeNull(); // 会话未被级联删
    });

    it("deleteProjectWithSessions 拒绝删除 default（项目与会话均保留）", async () => {
      const storage = await trackedInitializedMemoryDb();
      const repo = storage.projects;
      const sessions = storage.sessions;
      await repo.ensureDefaultProject(defaultRecord());
      await sessions.create({
        id: "s-default", ownerKey: "owner", projectId: DEFAULT_PROJECT_ID, title: "默认会话",
        createdAt: 1, updatedAt: 1, piSessionFile: null, modelProvider: null,
        modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
      });
      await expect(repo.deleteProjectWithSessions(DEFAULT_PROJECT_ID, ["s-default"])).rejects.toThrow(/默认项目不可删除/);
      expect(await repo.get(DEFAULT_PROJECT_ID)).not.toBeNull();
      expect(await sessions.get("s-default")).not.toBeNull(); // 会话未被删
    });
  });
});
