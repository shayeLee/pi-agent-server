import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityKey } from "../src/core/user-identity.js";
import type { SessionRecord } from "../src/application/ports/session-store-port.js";
import { SqliteSessionRepository } from "../src/storage/sqlite-session-repository.js";
import { DEFAULT_PROJECT_ID } from "../src/application/ports/project-store-port.js";
import { initStorage, makeInitializedMemoryDb } from "./helpers/sqlite.js";

function makeDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

async function makeRepo(db: DatabaseSync = makeDb()): Promise<SqliteSessionRepository> {
  // 真实初始化路径负责建表/索引/外键/默认项目；测试不绕过初始化。
  return (await initStorage(db)).sessions;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-" + Math.random().toString(36).slice(2),
    ownerKey: identityKey({ kind: "ip", ip: "10.0.0.1" }),
    projectId: DEFAULT_PROJECT_ID,
    title: "测试会话",
    createdAt: 1000,
    updatedAt: 1000,
    piSessionFile: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
    ...overrides,
  };
}

describe("会话索引存储（needs.md §4.1 / §4.2，SQLite 实现）", () => {
  describe("create / get", () => {
    it("create 后 get 返回完整记录", async () => {
      const repo = await makeRepo();
      const rec = makeRecord();
      await repo.create(rec);
      expect(await repo.get(rec.id)).toEqual(rec);
    });

    it("get 不存在的会话返回 null", async () => {
      const repo = await makeRepo();
      expect(await repo.get("no-such-id")).toBeNull();
    });
  });

  describe("listByOwner", () => {
    it("只返回该 owner 的会话，按 updatedAt 降序", async () => {
      const repo = await makeRepo();
      const owner = identityKey({ kind: "account", accountId: "acct-1" });
      const a = makeRecord({ id: "s1", ownerKey: owner, createdAt: 1000, updatedAt: 1000 });
      const b = makeRecord({ id: "s2", ownerKey: owner, createdAt: 3000, updatedAt: 3000 });
      const c = makeRecord({ id: "s3", ownerKey: owner, createdAt: 2000, updatedAt: 2000 });
      const other = makeRecord({
        id: "s4",
        ownerKey: identityKey({ kind: "account", accountId: "acct-2" }),
        createdAt: 9999,
        updatedAt: 9999,
      });
      for (const rec of [a, b, c, other]) await repo.create(rec);

      expect(await repo.listByOwner(owner)).toEqual([b, c, a]);
    });
  });

  describe("listByProject", () => {
    it("按 owner + project 双重过滤", async () => {
      const db = makeDb();
      const storage = await initStorage(db);
      const owner = identityKey({ kind: "account", accountId: "acct-1" });
      const projects = storage.projects;
      await projects.create({ id: "p1", name: "P1", cwd: "/tmp/p1", ownerKey: owner, createdAt: 1 });
      const repo = storage.sessions;
      const a = makeRecord({ id: "s1", ownerKey: owner, projectId: DEFAULT_PROJECT_ID });
      const b = makeRecord({ id: "s2", ownerKey: owner, projectId: "p1" });
      const c = makeRecord({ id: "s3", ownerKey: owner, projectId: "p1" });
      for (const rec of [a, b, c]) await repo.create(rec);

      expect(await repo.listByProject(owner, "p1")).toEqual([c, b]);
      expect(await repo.listByProject(owner, DEFAULT_PROJECT_ID)).toEqual([a]);
      expect(await repo.listByProject(owner, "no-such")).toEqual([]);
    });
  });

  describe("系统提示词补写", () => {
    it("仅为未记录提示词的历史会话补写，已有记录不可覆盖", async () => {
      const repo = await makeRepo();
      const legacy = makeRecord({ id: "legacy", systemPrompt: null });
      const recorded = makeRecord({ id: "recorded", systemPrompt: "历史提示词" });
      await repo.create(legacy);
      await repo.create(recorded);

      expect(await repo.backfillSystemPrompt("服务端提示词")).toBe(1);
      expect((await repo.get("legacy"))?.systemPrompt).toBe("服务端提示词");
      expect((await repo.get("recorded"))?.systemPrompt).toBe("历史提示词");
    });
  });

  describe("能力版本快照", () => {
    it("create 后 get 返回能力版本快照", async () => {
      const repo = await makeRepo();
      const rec = makeRecord({ capabilityVersions: '{"knowledge-qa":1}' });
      await repo.create(rec);

      expect((await repo.get(rec.id))?.capabilityVersions).toBe('{"knowledge-qa":1}');
    });
  });

  describe("update", () => {
    it("update 修改 title 返回 true，get 反映新值且其他字段不变", async () => {
      const repo = await makeRepo();
      const rec = makeRecord();
      await repo.create(rec);

      expect(await repo.update(rec.id, { title: "新标题" })).toBe(true);

      const got = await repo.get(rec.id);
      expect(got?.title).toBe("新标题");
      expect(got?.id).toBe(rec.id);
      expect(got?.ownerKey).toBe(rec.ownerKey);
      expect(got?.createdAt).toBe(rec.createdAt);
      expect(got?.updatedAt).toBe(rec.updatedAt);
    });

    it("update 只传 updatedAt 时保持 title 并更新 updatedAt", async () => {
      const repo = await makeRepo();
      const rec = makeRecord();
      await repo.create(rec);

      expect(await repo.update(rec.id, { updatedAt: 5000 })).toBe(true);

      const got = await repo.get(rec.id);
      expect(got?.title).toBe(rec.title);
      expect(got?.updatedAt).toBe(5000);
    });

    it("update 不存在的会话返回 false", async () => {
      const repo = await makeRepo();
      expect(await repo.update("no-such-id", { title: "x" })).toBe(false);
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

    it("delete 不存在的会话返回 false", async () => {
      const repo = await makeRepo();
      expect(await repo.delete("no-such-id")).toBe(false);
    });
  });

  describe("owner 隔离", () => {
    it("不同 owner 的数据互不串扰", async () => {
      const repo = await makeRepo();
      const ownerA = identityKey({ kind: "ip", ip: "10.1.1.1" });
      const ownerB = identityKey({ kind: "account", accountId: "acct-9" });
      await repo.create(makeRecord({ id: "a1", ownerKey: ownerA }));
      await repo.create(makeRecord({ id: "b1", ownerKey: ownerB, title: "B 的会话" }));

      const listA = await repo.listByOwner(ownerA);
      expect(listA).toHaveLength(1);
      expect(listA[0]?.id).toBe("a1");

      const listB = await repo.listByOwner(ownerB);
      expect(listB).toHaveLength(1);
      expect(listB[0]?.id).toBe("b1");

      const a = await repo.get("a1");
      const b = await repo.get("b1");
      expect(a?.ownerKey).toBe(ownerA);
      expect(b?.ownerKey).toBe(ownerB);
      expect(a?.title).toBe("测试会话");
      expect(b?.title).toBe("B 的会话");
    });
  });

  describe("WAL 配置（§4.1：文件数据库 WAL，:memory: 跳过，由 initializeDatabase 设置）", () => {
    it("文件数据库启用 WAL 模式", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-session-repo-"));
      const dbFile = join(dir, "sessions.db");
      const db = new DatabaseSync(dbFile);
      try {
        await initStorage(db);
        const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
        expect(row?.journal_mode).toBe("wal");
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(":memory: 数据库不启用 WAL（保持 memory 模式）", async () => {
      const db = makeDb();
      try {
        await initStorage(db);
        const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
        expect(row?.journal_mode).toBe("memory");
      } finally {
        db.close();
      }
    });
  });

  describe("外键约束（由初始化建立）", () => {
    it("插入 project_id 指向不存在项目时抛真实 errcode 787（SQLITE_CONSTRAINT_FOREIGNKEY）", async () => {
      const { sessions: repo } = await makeInitializedMemoryDb();
      let caught: unknown;
      try {
        await repo.create(makeRecord({ id: "s-ghost", projectId: "ghost-project" }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as { errcode?: number }).errcode).toBe(787);
    });
  });
});
