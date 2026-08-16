import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityKey } from "../src/core/user-identity.js";
import type { SessionRecord } from "../src/storage/session-repository.js";
import { SqliteSessionRepository } from "../src/storage/sqlite-session-repository.js";

function makeDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function makeRepo(db: DatabaseSync = makeDb()): SqliteSessionRepository {
  return new SqliteSessionRepository(db);
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-" + Math.random().toString(36).slice(2),
    ownerKey: identityKey({ kind: "ip", ip: "10.0.0.1" }),
    title: "测试会话",
    createdAt: 1000,
    updatedAt: 1000,
    piSessionFile: null,
    ...overrides,
  };
}

describe("会话索引存储（README §4.1 / §4.2，SQLite 实现）", () => {
  describe("create / get", () => {
    it("create 后 get 返回完整记录", async () => {
      const repo = makeRepo();
      const rec = makeRecord();
      await repo.create(rec);
      expect(await repo.get(rec.id)).toEqual(rec);
    });

    it("get 不存在的会话返回 null", async () => {
      const repo = makeRepo();
      expect(await repo.get("no-such-id")).toBeNull();
    });
  });

  describe("listByOwner", () => {
    it("只返回该 owner 的会话，按 updatedAt 降序", async () => {
      const repo = makeRepo();
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

  describe("update", () => {
    it("update 修改 title 返回 true，get 反映新值且其他字段不变", async () => {
      const repo = makeRepo();
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
      const repo = makeRepo();
      const rec = makeRecord();
      await repo.create(rec);

      expect(await repo.update(rec.id, { updatedAt: 5000 })).toBe(true);

      const got = await repo.get(rec.id);
      expect(got?.title).toBe(rec.title);
      expect(got?.updatedAt).toBe(5000);
    });

    it("update 不存在的会话返回 false", async () => {
      const repo = makeRepo();
      expect(await repo.update("no-such-id", { title: "x" })).toBe(false);
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

    it("delete 不存在的会话返回 false", async () => {
      const repo = makeRepo();
      expect(await repo.delete("no-such-id")).toBe(false);
    });
  });

  describe("owner 隔离", () => {
    it("不同 owner 的数据互不串扰", async () => {
      const repo = makeRepo();
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

  describe("WAL 配置（§4.1：文件数据库 WAL，:memory: 跳过）", () => {
    it("文件数据库启用 WAL 模式", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-session-repo-"));
      const dbFile = join(dir, "sessions.db");
      const db = new DatabaseSync(dbFile);
      try {
        makeRepo(db);
        const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
        expect(row?.journal_mode).toBe("wal");
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(":memory: 数据库不启用 WAL（保持 memory 模式）", () => {
      const db = makeDb();
      try {
        makeRepo(db);
        const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
        expect(row?.journal_mode).toBe("memory");
      } finally {
        db.close();
      }
    });
  });
});