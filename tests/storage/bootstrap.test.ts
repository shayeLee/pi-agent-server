// 空数据库 bootstrap（Kysely schema builder + bootstrap.ts）端到端测试：
// 全新库建表/索引/外键、文件库 WAL（:memory: 跳过）、幂等多次初始化不丢数据、
// 不产生 kysely_migration / kysely_migration_lock 表、bootstrap 不写默认项目、
// 默认项目由 ensureDefaultProject 创建且不覆盖既有行、Repository CRUD 与 CASCADE 生效。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import { sqliteConstraintErrorMapper } from "../../src/storage/sqlite-constraint-errors.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

const DEFAULT_PROJECT = {
  id: DEFAULT_PROJECT_ID,
  name: "默认项目",
  cwd: "/srv/cwd",
  ownerKey: "",
  createdAt: 0,
};

function sqliteTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function sqliteIndexes(db: DatabaseSync, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
      .all(table) as { name: string }[]
  ).map((r) => r.name);
}

function sessionsFk(db: DatabaseSync): { table: string; from: string; to: string; on_delete: string }[] {
  return db.prepare("PRAGMA foreign_key_list(sessions)").all() as {
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }[];
}

function columnNotNull(db: DatabaseSync, table: string): Record<string, number> {
  return Object.fromEntries(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]).map(
      (c) => [c.name, c.notnull],
    ) as [string, number][],
  );
}

/** 销毁 initializeDatabase 返回的 Kysely（经 adapter 关闭共享的 DatabaseSync；adapter 幂等关闭容忍多实例共享）。 */
async function destroyAll(...kyselys: (Kysely<DatabaseSchema> | null | undefined)[]): Promise<void> {
  for (const k of kyselys) {
    if (k) await k.destroy();
  }
}

describe("空数据库 bootstrap（Kysely schema builder + bootstrap.ts）", () => {
  it("全新库：全部表、索引与外键就位；不产生 kysely_migration 表", async () => {
    const db = new DatabaseSync(":memory:");
    const kysely = await initializeDatabase(db);

    expect(sqliteTables(db)).toEqual(
      expect.arrayContaining(["projects", "sessions", "idempotency"]),
    );
    // 无版本化迁移痕迹（本方案没有 Migrator，不应创建迁移簿记表）
    expect(sqliteTables(db)).not.toContain("kysely_migration");
    expect(sqliteTables(db)).not.toContain("kysely_migration_lock");

    expect(sqliteIndexes(db, "projects")).toContain("idx_projects_owner");
    expect(sqliteIndexes(db, "sessions")).toEqual(
      expect.arrayContaining(["idx_sessions_owner_updated", "idx_sessions_owner_project"]),
    );
    expect(sqliteIndexes(db, "idempotency")).toContain("idx_idempotency_created_at");

    expect(sessionsFk(db)).toContainEqual(
      expect.objectContaining({ table: "projects", from: "project_id", to: "id", on_delete: "CASCADE" }),
    );

    // bootstrap 不写默认项目（默认项目由 start.ts / mock 的 ensureDefaultProject 在初始化后创建）
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    await destroyAll(kysely);
  });

  it("文件库启用 WAL；:memory: 保持 memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bootstrap-wal-"));
    const dbFile = join(dir, "app.db");
    const fileDb = new DatabaseSync(dbFile);
    const fileKysely = await initializeDatabase(fileDb);
    expect((fileDb.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode).toBe("wal");
    await destroyAll(fileKysely);

    const memDb = new DatabaseSync(":memory:");
    const memKysely = await initializeDatabase(memDb);
    expect((memDb.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode).toBe("memory");
    await destroyAll(memKysely);
    rmSync(dir, { recursive: true, force: true });
  });

  it("初始化幂等：多次 initializeDatabase 不报错、schema 不变、数据保留", async () => {
    const db = new DatabaseSync(":memory:");
    const k1 = await initializeDatabase(db);
    const proj = new KyselyProjectRepository(k1, sqliteConstraintErrorMapper);
    await proj.create({ id: "p-x", name: "X", cwd: "/x", ownerKey: "o", createdAt: 1 });

    // 第二次初始化：全部 IF NOT EXISTS，不重复建表，数据保留
    const k2 = await initializeDatabase(db);
    expect((await proj.get("p-x"))?.name).toBe("X");
    expect(sqliteTables(db)).toEqual(expect.arrayContaining(["projects", "sessions", "idempotency"]));
    expect(sqliteTables(db)).not.toContain("kysely_migration");
    // 多个 Kysely 共享同一 DatabaseSync，逐一 destroy（adapter 幂等关闭容忍共享）
    await destroyAll(k1, k2);
  });

  it("默认项目由 ensureDefaultProject 创建，且不覆盖既有默认项目", async () => {
    const db = new DatabaseSync(":memory:");
    const kysely = await initializeDatabase(db);
    const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper);

    await projects.ensureDefaultProject({ ...DEFAULT_PROJECT, cwd: "/fresh-cwd" });
    expect(await projects.get(DEFAULT_PROJECT_ID)).toMatchObject({ id: DEFAULT_PROJECT_ID, cwd: "/fresh-cwd" });

    // 配置错误的 cwd 不得覆盖已存在默认项目
    await projects.ensureDefaultProject({ ...DEFAULT_PROJECT, cwd: "/misconfigured" });
    expect(await projects.get(DEFAULT_PROJECT_ID)).toMatchObject({ cwd: "/fresh-cwd" });
    await destroyAll(kysely);
  });

  it("Repository CRUD 与外键 CASCADE 生效；required 列 NOT NULL", async () => {
    const db = new DatabaseSync(":memory:");
    const kysely = await initializeDatabase(db);
    const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper);
    const sessions = new KyselySessionRepository(kysely, sqliteConstraintErrorMapper);
    await projects.ensureDefaultProject(DEFAULT_PROJECT);

    // 项目/会话 CRUD
    await projects.create({ id: "p1", name: "P1", cwd: "/p1", ownerKey: "o", createdAt: 1 });
    await sessions.create({
      id: "s1", ownerKey: "o", projectId: "p1", title: "t", createdAt: 1, updatedAt: 1,
      piSessionFile: null, modelProvider: null, modelId: null, thinkingLevel: null,
      systemPrompt: null, capabilityVersions: null,
    });
    expect(await sessions.get("s1")).toMatchObject({ id: "s1", projectId: "p1", title: "t" });

    // CASCADE：删项目级联删其会话
    await projects.delete("p1");
    expect(await sessions.get("s1")).toBeNull();

    // required 列 NOT NULL，可空列允许 NULL
    const nn = columnNotNull(db, "sessions");
    expect(nn["title"]).toBe(1);
    expect(nn["owner_key"]).toBe(1);
    expect(nn["project_id"]).toBe(1);
    expect(nn["created_at"]).toBe(1);
    expect(nn["updated_at"]).toBe(1);
    expect(nn["pi_session_file"]).toBe(0);
    await destroyAll(kysely);
  });
});

describe("旧 schema 严格兼容性 preflight（M1 升级：列名齐全但类型/FK/索引错误也要 fail-fast，无任何 DDL）", () => {
  // 构造「表已存在但形态旧」的 SQLite 库：sessions 缺 Manifest 第 12 列 capability_versions。
  // 严格 preflight 在**任何建表/建索引 DDL 之前**执行，未通过时连 CREATE INDEX IF NOT EXISTS 都不允许发生。
  function oldSchemaSql(): string {
    return `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        owner_key TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}',
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pi_session_file TEXT,
        model_provider TEXT,
        model_id TEXT,
        thinking_level TEXT,
        system_prompt TEXT
      );
      CREATE TABLE idempotency (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );
    `;
  }

  it("旧 schema（缺 capability_versions 列）初始化 fail-fast，且失败路径关闭了 Kysely/底层 DatabaseSync", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(oldSchemaSql());

    const err = await initializeDatabase(db).then(() => null, (e: unknown) => e);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/不兼容/);
    expect(message).toMatch(/capability_versions/);
    expect(message).toMatch(/ALTER/); // 明确声明未执行 ALTER/补列
    // 失败路径 destroy 了 Kysely → adapter 按真实所有权关闭了同一 DatabaseSync
    expect(() => db.prepare("SELECT 1")).toThrow(/not open/i);
  });

  it("旧 schema 初始化失败后未执行 ALTER/补列：用新连接复查 session 列仍缺 capability_versions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bootstrap-old-schema-"));
    const file = join(dir, "old.db");
    try {
      // 独立连接写入旧 schema 后关闭
      const writer = new DatabaseSync(file);
      writer.exec(oldSchemaSql());
      writer.close();

      await expect(initializeDatabase(new DatabaseSync(file))).rejects.toThrow(/不兼容/);

      // 新连接复查：任何 ALTER/补列都不允许发生（RC 阶段无迁移）
      const reader = new DatabaseSync(file);
      try {
        const cols = reader.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
        expect(cols.map((c) => c.name)).not.toContain("capability_versions");
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("全新库/当前 schema 通过兼容性检查（不误伤），仍可正常初始化", async () => {
    const db = new DatabaseSync(":memory:");
    const kysely = await initializeDatabase(db); // 不抛错即通过
    expect(sqliteTables(db)).toEqual(expect.arrayContaining(["projects", "sessions", "idempotency"]));
    await destroyAll(kysely);
  });

  // —— 以下为严格契约新增（最终测试审计 P1）：列名齐全但物理类型 / FK / 索引错误必须 fail-fast，
  // 且失败发生在任何 DDL 之前（无 ALTER/补列/建表/建索引的 DDL mutation）。

  /** 三张表列名与 Manifest 完全一致；用开关破坏物理契约（类型 / FK / 索引）。 */
  function nearCurrentSchemaSql(opts: {
    createdAtIndexType?: string;
    fkAction?: string;
    indexErrors?: boolean;
  } = {}): string {
    const createdAtIndexType = opts.createdAtIndexType ?? "INTEGER";
    const fkAction = opts.fkAction ?? "CASCADE";
    const indexes = opts.indexErrors
      ? // 缺 idx_projects_owner；idx_sessions_owner_updated 去掉 updated_at DESC；缺 idx_idempotency_created_at
        `
        CREATE INDEX idx_sessions_owner_updated ON sessions(owner_key, updated_at);
        CREATE INDEX idx_sessions_owner_project ON sessions(owner_key, project_id);
      `
      : `
        CREATE INDEX idx_projects_owner ON projects(owner_key);
        CREATE INDEX idx_sessions_owner_updated ON sessions(owner_key, updated_at DESC);
        CREATE INDEX idx_sessions_owner_project ON sessions(owner_key, project_id);
        CREATE INDEX idx_idempotency_created_at ON idempotency(created_at);
      `;
    return `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        created_at ${createdAtIndexType} NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        owner_key TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_ID}',
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pi_session_file TEXT,
        model_provider TEXT,
        model_id TEXT,
        thinking_level TEXT,
        system_prompt TEXT,
        capability_versions TEXT,
        CONSTRAINT sessions_project_id_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE ${fkAction}
      );
      CREATE TABLE idempotency (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );
      ${indexes}
    `;
  }

  /** 捕获 preflight 失败的错误消息；统一断言「不兼容」+ 不点名具体问题。 */
  async function failedMessage(sqlText: string): Promise<string> {
    const db = new DatabaseSync(":memory:");
    db.exec(sqlText);
    const err = await initializeDatabase(db).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    return err instanceof Error ? err.message : String(err);
  }

  it("列名齐全但物理类型错误（projects.created_at 用 TEXT）→ fail-fast，点名列与物理类型", async () => {
    const message = await failedMessage(nearCurrentSchemaSql({ createdAtIndexType: "TEXT" }));
    expect(message).toMatch(/不兼容/);
    expect(message).toMatch(/created_at/);
    expect(message).toMatch(/物理类型不匹配/);
    expect(message).toMatch(/期望 integer，实际 text/);
  });

  it("FK / 索引错误（FK 非 CASCADE + 缺索引 + 索引缺 DESC）→ fail-fast，点名外键与索引", async () => {
    const message = await failedMessage(
      nearCurrentSchemaSql({ fkAction: "RESTRICT", indexErrors: true }),
    );
    expect(message).toMatch(/不兼容/);
    expect(message).toMatch(/外键/);
    expect(message).toMatch(/sessions_project_id_fk/);
    expect(message).toMatch(/索引/);
    expect(message).toMatch(/idx_projects_owner/); // 缺索引被点名
    expect(message).toMatch(/updated_at desc/); // 排序方向错误被点名（期望 updated_at desc）
  });

  it("fail-fast 发生在任何 DDL 之前：sqlite_master / 列 / FK / 索引快照在失败前后逐字不变（无 DDL mutation）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bootstrap-no-ddl-"));
    const file = join(dir, "bad.db");
    try {
      // 独立连接写入坏 schema 后关闭（initializeDatabase 失败路径会关闭它自己打开的 DatabaseSync）
      const writer = new DatabaseSync(file);
      writer.exec(nearCurrentSchemaSql({ createdAtIndexType: "TEXT", indexErrors: true }));
      writer.close();

      const snapshot = (db: DatabaseSync): unknown => ({
        master: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
        tables: ["projects", "sessions", "idempotency"].map((t) => ({
          table: t,
          info: db.prepare(`PRAGMA table_info(${t})`).all(),
          fk: db.prepare(`PRAGMA foreign_key_list(${t})`).all(),
          indexes: db.prepare(`PRAGMA index_list(${t})`).all(),
        })),
      });

      const beforeDb = new DatabaseSync(file);
      const before = snapshot(beforeDb);
      beforeDb.close();

      await expect(initializeDatabase(new DatabaseSync(file))).rejects.toThrow(/不兼容/);

      const afterDb = new DatabaseSync(file);
      const after = snapshot(afterDb);
      afterDb.close();
      // 逐字不变：没有任何 ALTER/补列，也没有创建缺失表/索引（CREATE INDEX IF NOT EXISTS 也不允许发生）
      expect(after).toEqual(before);
      // 复查：缺失索引确实仍是缺失状态（没有任何建索引 DDL 发生）
      const reader = new DatabaseSync(file);
      try {
        expect(sqliteIndexes(reader, "projects")).not.toContain("idx_projects_owner");
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
