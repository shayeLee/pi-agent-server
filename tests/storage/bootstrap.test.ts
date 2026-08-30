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
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { SqliteProjectRepository } from "../../src/storage/sqlite-project-repository.js";
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
    const proj = new SqliteProjectRepository(k1);
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
    const projects = new SqliteProjectRepository(kysely);

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
    const projects = new SqliteProjectRepository(kysely);
    const sessions = new SqliteSessionRepository(kysely);
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
