// 空数据库初始化（Phase 1 存储层演进：Kysely 0.29.5 + node:sqlite 薄适配器）：
//   - WAL（文件数据库启用，:memory: 跳过，与外键/5s timeout 选项在 start.ts 的 DatabaseSync
//     创建时一并设置）；
//   - 用 Kysely schema builder 幂等创建当前 projects / sessions / idempotency 表与索引/FK
//     （全部 CREATE TABLE/INDEX IF NOT EXISTS），仅面向全新或已是当前 schema 的数据库；
//   - 不做任何旧库兼容/版本化迁移：RC 阶段旧表/旧数据直接删除，schema 演进走完整重建。
//   - 默认项目不在此处写入：由 start.ts / mock 在初始化后经 Repository.ensureDefaultProject 创建，
//     保证「不得用配置错误的默认 cwd 覆盖已存在默认项目」。

import { DatabaseSync } from "node:sqlite";
import { Kysely, SqliteDialect } from "kysely";
import { DEFAULT_PROJECT_ID } from "../application/ports/project-store-port.js";
import { NodeSqliteAdapter } from "./node-sqlite-adapter.js";
import type { DatabaseSchema } from "./db-schema.js";

export function isMemoryDatabase(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA database_list").get() as { file?: unknown } | undefined;
  return row?.file === "";
}

/**
 * 启用 WAL（文件数据库；:memory: 保持 memory 模式）并以 Kysely schema builder 幂等创建
 * 当前 schema（表/索引/外键）。可安全多次启动（全部 IF NOT EXISTS），
 * 但只适用于全新或已是当前 schema 的数据库。
 * 返回共享的 Kysely 实例；调用方负责在关闭时 destroy 它（会关闭底层 DatabaseSync）。
 */
export async function initializeDatabase(db: DatabaseSync): Promise<Kysely<DatabaseSchema>> {
  if (!isMemoryDatabase(db)) {
    db.exec("PRAGMA journal_mode=WAL");
  }

  const kysely = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: new NodeSqliteAdapter(db) }),
  });

  try {
    // projects（sessions 外键目标，必须先建）
    await kysely.schema
      .createTable("projects")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("cwd", "text", (col) => col.notNull())
      .addColumn("owner_key", "text", (col) => col.notNull())
      .addColumn("created_at", "integer", (col) => col.notNull())
      .execute();
    await kysely.schema
      .createIndex("idx_projects_owner")
      .ifNotExists()
      .on("projects")
      .column("owner_key")
      .execute();

    // sessions + 外键（project_id → projects.id ON DELETE CASCADE）+ 查询索引
    await kysely.schema
      .createTable("sessions")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("owner_key", "text", (col) => col.notNull())
      .addColumn("project_id", "text", (col) => col.notNull().defaultTo(DEFAULT_PROJECT_ID))
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("created_at", "integer", (col) => col.notNull())
      .addColumn("updated_at", "integer", (col) => col.notNull())
      .addColumn("pi_session_file", "text")
      .addColumn("model_provider", "text")
      .addColumn("model_id", "text")
      .addColumn("thinking_level", "text")
      .addColumn("system_prompt", "text")
      .addColumn("capability_versions", "text")
      .addForeignKeyConstraint("sessions_project_id_fk", ["project_id"], "projects", ["id"], (cb) =>
        cb.onDelete("cascade"),
      )
      .execute();
    await kysely.schema
      .createIndex("idx_sessions_owner_updated")
      .ifNotExists()
      .on("sessions")
      .columns(["owner_key", "updated_at desc"])
      .execute();
    await kysely.schema
      .createIndex("idx_sessions_owner_project")
      .ifNotExists()
      .on("sessions")
      .columns(["owner_key", "project_id"])
      .execute();

    // idempotency（复合主键 session_id + request_id）+ 清理索引
    await kysely.schema
      .createTable("idempotency")
      .ifNotExists()
      .addColumn("session_id", "text", (col) => col.notNull())
      .addColumn("request_id", "text", (col) => col.notNull())
      .addColumn("result", "text", (col) => col.notNull())
      .addColumn("created_at", "integer", (col) => col.notNull())
      .addPrimaryKeyConstraint("idempotency_pk", ["session_id", "request_id"])
      .execute();
    await kysely.schema
      .createIndex("idx_idempotency_created_at")
      .ifNotExists()
      .on("idempotency")
      .column("created_at")
      .execute();

    return kysely;
  } catch (error) {
    await kysely.destroy();
    throw error;
  }
}
