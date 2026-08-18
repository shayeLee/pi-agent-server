import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { identityKey } from "../src/core/user-identity.js";
import type { ProjectRecord } from "../src/application/ports/project-store-port.js";
import type { SessionRecord } from "../src/application/ports/session-store-port.js";
import { SqliteProjectRepository } from "../src/storage/sqlite-project-repository.js";
import { SqliteSessionRepository } from "../src/storage/sqlite-session-repository.js";

function makeDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function makeRepo(db: DatabaseSync = makeDb()): SqliteProjectRepository {
  return new SqliteProjectRepository(db);
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

describe("项目索引存储（多项目，SQLite 实现）", () => {
  describe("create / get", () => {
    it("create 后 get 返回完整记录", async () => {
      const repo = makeRepo();
      const rec = makeRecord();
      await repo.create(rec);
      expect(await repo.get(rec.id)).toEqual(rec);
    });

    it("get 不存在的项目返回 null", async () => {
      const repo = makeRepo();
      expect(await repo.get("no-such-id")).toBeNull();
    });
  });

  describe("listByOwner", () => {
    it("只返回该 owner 的项目，按 createdAt 降序", async () => {
      const repo = makeRepo();
      const owner = identityKey({ kind: "account", accountId: "acct-1" });
      const a = makeRecord({ id: "p1", ownerKey: owner, createdAt: 1000 });
      const b = makeRecord({ id: "p2", ownerKey: owner, createdAt: 3000 });
      const other = makeRecord({
        id: "p3",
        ownerKey: identityKey({ kind: "account", accountId: "acct-2" }),
        createdAt: 9999,
      });
      for (const rec of [a, b, other]) await repo.create(rec);

      expect(await repo.listByOwner(owner)).toEqual([b, a]);
    });
  });

  describe("delete", () => {
    it("delete 返回 true 且 get 变 null", async () => {
      const repo = makeRepo();
      const rec = makeRecord();
      await repo.create(rec);

      expect(await repo.delete(rec.id)).toBe(true);
      expect(await repo.get(rec.id)).toBeNull();
    });

    it("delete 不存在的项目返回 false", async () => {
      const repo = makeRepo();
      expect(await repo.delete("no-such-id")).toBe(false);
    });
  });

  describe("deleteProjectWithSessions（事务逻辑删）", () => {
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

    it("同一事务删除项目及其所有会话", async () => {
      const db = makeDb();
      const repo = new SqliteProjectRepository(db);
      const sessions = new SqliteSessionRepository(db);

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
      const db = makeDb();
      const repo = new SqliteProjectRepository(db);
      new SqliteSessionRepository(db);
      await repo.create(makeRecord({ id: "p1" }));

      await repo.deleteProjectWithSessions("p1", []);
      expect(await repo.get("p1")).toBeNull();
    });

    it("外键 CASCADE：直接删项目自动级联删其会话（数据库层兑底，无需显式删 sessions）", async () => {
      const db = makeDb();
      const repo = new SqliteProjectRepository(db);
      const sessions = new SqliteSessionRepository(db);
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
      const repo = makeRepo();
      const ownerA = identityKey({ kind: "ip", ip: "10.1.1.1" });
      const ownerB = identityKey({ kind: "account", accountId: "acct-9" });
      await repo.create(makeRecord({ id: "a1", ownerKey: ownerA, name: "A 项目" }));
      await repo.create(makeRecord({ id: "b1", ownerKey: ownerB, name: "B 项目" }));

      expect(await repo.listByOwner(ownerA)).toHaveLength(1);
      expect((await repo.listByOwner(ownerA))[0]?.name).toBe("A 项目");
      expect((await repo.listByOwner(ownerB))[0]?.name).toBe("B 项目");
    });
  });

  describe("默认项目不变量（保留 id 由 ensureDefaultProject 独占）", () => {
    const defaultRecord = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
      id: "default",
      name: "默认项目",
      cwd: "/tmp/default",
      ownerKey: "",
      createdAt: 0,
      ...overrides,
    });

    it("ensureDefaultProject 拒绝非 default id 或非空 owner", async () => {
      const repo = makeRepo();
      await expect(repo.ensureDefaultProject(defaultRecord({ id: "not-default" }))).rejects.toThrow(/默认项目 id/);
      await expect(repo.ensureDefaultProject(defaultRecord({ ownerKey: "owner-x" }))).rejects.toThrow(/空 owner/);
    });

    it("ensureDefaultProject 对既有异常 owner 行显式失败（而非静默 IGNORE）", async () => {
      const db = makeDb();
      const repo = makeRepo(db);
      // 直接插入异常 default 行（绕过 create 的拒绝，模拟历史/直接写入）
      db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("default", "默认项目", "/tmp/default", "owner-x", 0);
      await expect(repo.ensureDefaultProject(defaultRecord())).rejects.toThrow(/owner 非空/);
    });

    it("create 拒绝写入 default id（无论 owner 是否为空）", async () => {
      const repo = makeRepo();
      await expect(repo.create(defaultRecord({ ownerKey: "owner-x" }))).rejects.toThrow(/独占/);
      await expect(repo.create(defaultRecord({ ownerKey: "" }))).rejects.toThrow(/独占/);
    });

    it("delete 拒绝删除 default（返回 false，且不触发 CASCADE）", async () => {
      const db = makeDb();
      const repo = makeRepo(db);
      await repo.ensureDefaultProject(defaultRecord());
      const sessions = new SqliteSessionRepository(db);
      await sessions.create({
        id: "s-default", ownerKey: "owner", projectId: "default", title: "默认会话",
        createdAt: 1, updatedAt: 1, piSessionFile: null, modelProvider: null,
        modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
      });

      expect(await repo.delete("default")).toBe(false);
      expect(await repo.get("default")).not.toBeNull(); // 项目仍在
      expect(await sessions.get("s-default")).not.toBeNull(); // 会话未被级联删
    });

    it("deleteProjectWithSessions 拒绝删除 default（项目与会话均保留）", async () => {
      const db = makeDb();
      const repo = makeRepo(db);
      await repo.ensureDefaultProject(defaultRecord());
      const sessions = new SqliteSessionRepository(db);
      await sessions.create({
        id: "s-default", ownerKey: "owner", projectId: "default", title: "默认会话",
        createdAt: 1, updatedAt: 1, piSessionFile: null, modelProvider: null,
        modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
      });
      await expect(repo.deleteProjectWithSessions("default", ["s-default"])).rejects.toThrow(/默认项目不可删除/);
      expect(await repo.get("default")).not.toBeNull();
      expect(await sessions.get("s-default")).not.toBeNull(); // 会话未被删
    });
  });
});
