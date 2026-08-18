import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityKey } from "../src/core/user-identity.js";
import type { SessionRecord } from "../src/application/ports/session-store-port.js";
import { SqliteSessionRepository } from "../src/storage/sqlite-session-repository.js";
import { SqliteProjectRepository } from "../src/storage/sqlite-project-repository.js";

function makeDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function makeRepo(db: DatabaseSync = makeDb()): SqliteSessionRepository {
  // 外键约束要求 projects 表存在且含 'default' 行（与 start.ts 的初始化顺序一致）
  const projects = new SqliteProjectRepository(db);
  void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
  return new SqliteSessionRepository(db);
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-" + Math.random().toString(36).slice(2),
    ownerKey: identityKey({ kind: "ip", ip: "10.0.0.1" }),
    projectId: "default",
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

  describe("listByProject", () => {
    it("按 owner + project 双重过滤", async () => {
      const db = makeDb();
      const owner = identityKey({ kind: "account", accountId: "acct-1" });
      // 外键约束要求 sessions.project_id 引用存在的项目：默认项目 + p1
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      await projects.create({ id: "p1", name: "P1", cwd: "/tmp/p1", ownerKey: owner, createdAt: 1 });
      const repo = new SqliteSessionRepository(db);
      const a = makeRecord({ id: "s1", ownerKey: owner, projectId: "default" });
      const b = makeRecord({ id: "s2", ownerKey: owner, projectId: "p1" });
      const c = makeRecord({ id: "s3", ownerKey: owner, projectId: "p1" });
      for (const rec of [a, b, c]) await repo.create(rec);

      expect(await repo.listByProject(owner, "p1")).toEqual([c, b]);
      expect(await repo.listByProject(owner, "default")).toEqual([a]);
      expect(await repo.listByProject(owner, "no-such")).toEqual([]);
    });
  });

  describe("系统提示词补写", () => {
    it("仅为未记录提示词的历史会话补写，已有记录不可覆盖", async () => {
      const repo = makeRepo();
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
      const repo = makeRepo();
      const rec = makeRecord({ capabilityVersions: '{"knowledge-qa":1}' });
      await repo.create(rec);

      expect((await repo.get(rec.id))?.capabilityVersions).toBe('{"knowledge-qa":1}');
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

  describe("外键迁移（旧库无外键 → 重建）", () => {
    /** 构造旧版无外键的 sessions 表，可模拟不同历史版本（缺 project_id 或后加列）。 */
    function createLegacySessions(
      db: DatabaseSync,
      opts: { withProjectId?: boolean; withLaterColumns?: boolean; withPiSessionFile?: boolean } = {},
    ): void {
      const withProjectId = opts.withProjectId ?? true;
      const withLaterColumns = opts.withLaterColumns ?? true;
      const withPiSessionFile = opts.withPiSessionFile ?? true;
      const columns = [
        "id TEXT PRIMARY KEY",
        "owner_key TEXT NOT NULL",
        ...(withProjectId ? ["project_id TEXT NOT NULL DEFAULT 'default'"] : []),
        "title TEXT NOT NULL",
        "created_at INTEGER NOT NULL",
        "updated_at INTEGER NOT NULL",
        ...(withPiSessionFile ? ["pi_session_file TEXT"] : []),
        ...(withLaterColumns
          ? ["model_provider TEXT", "model_id TEXT", "thinking_level TEXT", "system_prompt TEXT", "capability_versions TEXT"]
          : []),
      ].join(", ");
      db.exec(`CREATE TABLE sessions (${columns});`);
    }

    it("旧库无外键时重建：全字段保留 + 外键 CASCADE 生效", async () => {
      const db = makeDb();
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      await projects.create({ id: "p1", name: "P1", cwd: "/tmp/p1", ownerKey: "owner", createdAt: 1 });
      createLegacySessions(db);
      db.prepare(
        "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("s-old", "owner", "p1", "旧会话", 1, 2, "/tmp/s.jsonl", "deepseek", "v4-pro", "high", "系统提示词", '{"k":1}');

      const repo = new SqliteSessionRepository(db);
      const fk = db.prepare("PRAGMA foreign_key_list(sessions)").all() as { table?: string; on_delete?: string }[];
      expect(fk).toContainEqual(expect.objectContaining({ table: "projects", from: "project_id", to: "id", on_delete: "CASCADE" }));

      // 全字段保留
      expect(await repo.get("s-old")).toMatchObject({
        id: "s-old", ownerKey: "owner", projectId: "p1", title: "旧会话",
        createdAt: 1, updatedAt: 2, piSessionFile: "/tmp/s.jsonl",
        modelProvider: "deepseek", modelId: "v4-pro", thinkingLevel: "high",
        systemPrompt: "系统提示词", capabilityVersions: '{"k":1}',
      });

      // 外键 CASCADE 生效
      await projects.delete("p1");
      expect(await repo.get("s-old")).toBeNull();
    });

    it("旧表缺 project_id 列：补列 + 重建，外键 CASCADE 生效", async () => {
      const db = makeDb();
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      createLegacySessions(db, { withProjectId: false });
      db.prepare("INSERT INTO sessions (id, owner_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("s-old", "owner", "旧会话", 1, 1);

      const repo = new SqliteSessionRepository(db);
      // 验证确实重建加了外键（而非仅补列）
      const fk = db.prepare("PRAGMA foreign_key_list(sessions)").all() as { table?: string; on_delete?: string }[];
      expect(fk).toContainEqual(expect.objectContaining({ table: "projects", from: "project_id", to: "id", on_delete: "CASCADE" }));
      // 补列默认归 default
      expect((await repo.get("s-old"))?.projectId).toBe("default");
    });

    it("最早期 schema（仅初始列）升级：补所有后加列，新字段为 null，外键生效", async () => {
      const db = makeDb();
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      createLegacySessions(db, { withProjectId: false, withLaterColumns: false });
      db.prepare("INSERT INTO sessions (id, owner_key, title, created_at, updated_at, pi_session_file) VALUES (?, ?, ?, ?, ?, ?)")
        .run("s-old", "owner", "旧会话", 1, 2, "/tmp/s.jsonl");

      const repo = new SqliteSessionRepository(db);
      expect(await repo.get("s-old")).toMatchObject({
        id: "s-old", ownerKey: "owner", projectId: "default", title: "旧会话",
        createdAt: 1, updatedAt: 2, piSessionFile: "/tmp/s.jsonl",
        modelProvider: null, modelId: null, thinkingLevel: null,
        systemPrompt: null, capabilityVersions: null,
      });
    });

    it("旧表缺 pi_session_file 列：补列后为 null，不影响其余数据", async () => {
      const db = makeDb();
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      createLegacySessions(db, { withPiSessionFile: false });
      db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("s-old", "owner", "default", "旧会话", 1, 1);

      const repo = new SqliteSessionRepository(db);
      expect(await repo.get("s-old")).toMatchObject({
        id: "s-old", projectId: "default", title: "旧会话", piSessionFile: null,
      });
    });

    it("迁移只清理孤儿：同批有效记录保留、孤儿删除", async () => {
      const db = makeDb();
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      await projects.create({ id: "p1", name: "P1", cwd: "/tmp/p1", ownerKey: "owner", createdAt: 1 });
      createLegacySessions(db);
      db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("s-valid", "owner", "p1", "有效", 1, 1);
      db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("s-orphan", "owner", "ghost-project", "孤儿", 1, 1);

      const repo = new SqliteSessionRepository(db);
      expect((await repo.get("s-valid"))?.title).toBe("有效"); // 有效记录保留
      expect(await repo.get("s-orphan")).toBeNull(); // 孤儿删除
    });

    it("检测到残留 sessions_old 时 fail-fast，且不破坏残留数据", () => {
      const db = makeDb();
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      db.exec("CREATE TABLE sessions_old (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, title TEXT NOT NULL)");
      db.prepare("INSERT INTO sessions_old (id, owner_key, title) VALUES (?, ?, ?)").run("s-old", "owner", "残留数据");
      expect(() => new SqliteSessionRepository(db)).toThrow(/sessions_old/);
      // 数据未被破坏（fail-fast 不应破坏性清理）
      const row = db.prepare("SELECT title FROM sessions_old WHERE id = ?").get("s-old") as { title?: string } | undefined;
      expect(row?.title).toBe("残留数据");
    });

    it("插入 project_id 指向不存在项目时抛真实 errcode 787（SQLITE_CONSTRAINT_FOREIGNKEY）", async () => {
      const db = makeDb();
      const projects = new SqliteProjectRepository(db);
      void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default", ownerKey: "", createdAt: 0 });
      const repo = new SqliteSessionRepository(db);
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