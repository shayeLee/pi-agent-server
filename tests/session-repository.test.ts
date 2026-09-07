import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityKey } from "../src/core/user-identity.js";
import type { SessionRecord } from "../src/application/ports/session-store-port.js";
import { KyselySessionRepository } from "../src/storage/kysely-session-repository.js";
import { DEFAULT_PROJECT_ID } from "../src/application/ports/project-store-port.js";
import { DuplicateIdError, ProjectForeignKeyError } from "../src/application/ports/store-errors.js";
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

async function makeRepo(db: DatabaseSync = makeDb()): Promise<KyselySessionRepository> {
  // 真实初始化路径负责建表/索引/外键/默认项目；测试不绕过初始化。fixture 由 afterEach 统一 close。
  const storage = await initStorage(db);
  openStorages.push(storage);
  return storage.sessions;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-" + Math.random().toString(36).slice(2),
    ownerKey: identityKey({ kind: "ip", ip: "10.0.0.1" }),
    projectId: DEFAULT_PROJECT_ID,
    title: "测试会话",
    createdAt: 1000,
    updatedAt: 1000,
    agentKind: "pi",
    conversationFormat: "pi-jsonl-v3",
    conversationRef: null,
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

    it("create 撞主键（重复 id）时转换为存储无关的 DuplicateIdError 并保留原始 cause", async () => {
      const repo = await makeRepo();
      const rec = makeRecord({ id: "s-dup" });
      await repo.create(rec);

      const err = await repo.create(rec).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(DuplicateIdError);
      expect((err as DuplicateIdError).message).toMatch(/主键/);
      // 原始 SQLite 约束错误保留在 cause（1555 = SQLITE_CONSTRAINT_PRIMARYKEY）
      expect((((err as DuplicateIdError).cause) as { errcode?: number }).errcode).toBe(1555);
    });

    it("非 id 列的 2067 唯一约束冲突原样抛出（不映射为 DuplicateIdError）", async () => {
      const storage = await makeInitializedMemoryDb();
      openStorages.push(storage);
      const { db, sessions: repo } = storage;
      // 在已有非 id 列上创建唯一索引，模拟未来新增唯一约束
      db.exec("CREATE UNIQUE INDEX idx_test_title ON sessions(title)");
      await repo.create(makeRecord({ id: "s-nid1", title: "唯一标题" }));

      const err = await repo
        .create(makeRecord({ id: "s-nid2", title: "唯一标题" }))
        .then(() => null, (e: unknown) => e);
      // 非 id 唯一约束错误必须原样抛出，不映射为 DuplicateIdError
      expect(err).toBeDefined();
      expect(err).not.toBeInstanceOf(DuplicateIdError);
      expect((err as { errcode?: number }).errcode).toBe(2067);
      expect((err as Error).message).toMatch(/sessions\.title/);
    });
  });

  describe("listByOwner", () => {
    it("只返回该 owner 的会话，按 updatedAt 降序", async () => {
      const repo = await makeRepo();
      const owner = identityKey({ kind: "ip", ip: "10.0.0.1" });
      const a = makeRecord({ id: "s1", ownerKey: owner, createdAt: 1000, updatedAt: 1000 });
      const b = makeRecord({ id: "s2", ownerKey: owner, createdAt: 3000, updatedAt: 3000 });
      const c = makeRecord({ id: "s3", ownerKey: owner, createdAt: 2000, updatedAt: 2000 });
      const other = makeRecord({
        id: "s4",
        ownerKey: identityKey({ kind: "ip", ip: "10.0.0.2" }),
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
      openStorages.push(storage);
      const owner = identityKey({ kind: "ip", ip: "10.0.0.1" });
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

  describe("conversation_ref reservation", () => {
    it("只允许第一个 reservation 写入引用，且不覆盖已有引用", async () => {
      const repo = await makeRepo();
      const rec = makeRecord();
      await repo.create(rec);

      expect(await repo.reserveConversation(rec.id, { conversationRef: "/tmp/sessions/s1/history.jsonl", tombstoneOperationKey: "tombstone-none" })).toBe(true);
      expect(await repo.reserveConversation(rec.id, { conversationRef: "/tmp/sessions/s1/other.jsonl", tombstoneOperationKey: "tombstone-none" })).toBe(false);
      expect((await repo.get(rec.id))?.conversationRef).toBe("/tmp/sessions/s1/history.jsonl");
      expect(await repo.reserveConversation("missing", { conversationRef: "/tmp/sessions/missing/history.jsonl", tombstoneOperationKey: "tombstone-none" })).toBe(false);
    });

    it("仅持有相同 reservation 的创建者可以提交实际引用", async () => {
      const repo = await makeRepo();
      const rec = makeRecord();
      await repo.create(rec);
      expect(await repo.reserveConversation(rec.id, { conversationRef: "proposal", tombstoneOperationKey: "tombstone-none" })).toBe(true);
      expect(await repo.commitConversationReservation(rec.id, "other", "actual")).toBe(false);
      expect((await repo.get(rec.id))?.conversationRef).toBe("proposal");
      expect(await repo.commitConversationReservation(rec.id, "proposal", "actual")).toBe(true);
      expect((await repo.get(rec.id))?.conversationRef).toBe("actual");
      expect(await repo.commitConversationReservation("missing", "actual", "next")).toBe(false);
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
      const ownerB = identityKey({ kind: "ip", ip: "10.0.0.9" });
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
      const storage = await initStorage(db);
      try {
        const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
        expect(row?.journal_mode).toBe("wal");
      } finally {
        await storage.close(); // 按真实所有权经 Kysely destroy 关闭（不直接 db.close() 绕过）
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(":memory: 数据库不启用 WAL（保持 memory 模式）", async () => {
      const db = makeDb();
      const storage = await initStorage(db);
      try {
        const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
        expect(row?.journal_mode).toBe("memory");
      } finally {
        await storage.close();
      }
    });
  });

  describe("外键约束（由初始化建立）", () => {
    it("create 撞 project_id 外键（项目已被删）时转换为存储无关 ProjectForeignKeyError 并保留原始 cause（errcode=787）", async () => {
      const repo = await makeRepo();

      const err = await repo
        .create(makeRecord({ id: "s-ghost", projectId: "ghost-project" }))
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(ProjectForeignKeyError);
      expect(err).not.toBeInstanceOf(DuplicateIdError);
      expect((err as Error).message).toMatch(/外键/);
      // 原始 SQLite 外键约束错误保留在 cause（787 = SQLITE_CONSTRAINT_FOREIGNKEY）
      expect((((err as ProjectForeignKeyError).cause) as { errcode?: number }).errcode).toBe(787);
    });
  });
});
