// SQLite 空数据库初始化（工作包 B/C：消费运行时 Schema Manifest 生成 SQLite 方言 bootstrap）：
//   - 本文件是 SQLite 方言入口：逻辑列类型 → SQLite 物理类型映射（SQLITE_LOGICAL_TYPE）+ WAL 行为，
//     实际的 Manifest→DDL 流程在 schema-builder.ts（与 PG bootstrap 共用，Manifest 仍是唯一来源）；
//   - WAL（文件数据库启用，:memory: 跳过，与外键/5s timeout 选项在 start.ts 的 DatabaseSync
//     创建时一并设置）；
//   - 表/列/主键/外键/索引的全部声明来自 schema-manifest.ts 的 schemaManifest（唯一来源）；
//   - 仅面向全新或已是当前 schema 的数据库：不做任何旧库兼容/版本化迁移（RC 阶段旧表
//     直接删除，schema 演进走完整重建），不产生 kysely_migration 表；
//   - 默认项目不在此处写入：由 start.ts / mock 在初始化后经 Repository.ensureDefaultProject
//     创建，保证「不得用配置错误的默认 cwd 覆盖已存在默认项目」。

import { DatabaseSync } from "node:sqlite";
import { Kysely, SqliteDialect } from "kysely";
import {
  bootstrapSchemaFromManifest,
  type LogicalTypeMap,
  type SchemaBootstrapOptions,
} from "./schema-builder.js";
import { assertSchemaCompatible } from "./schema-compatibility.js";
import { NodeSqliteAdapter } from "./node-sqlite-adapter.js";
import type { DatabaseSchema } from "./db-schema.js";
import { schemaManifest } from "./schema-manifest.js";
import { SQLITE_PHYSICAL_TYPES } from "./migration-manifest.js";
import { registerSqliteWriteLockKey, sqliteWriteLockKeyForFilename } from "./sqlite-write-lock.js";

/** 逻辑列类型 → SQLite 物理类型（uuid/text/json → TEXT、integer/bigint → INTEGER）。
 *  PG 映射（uuid → UUID、integer/bigint → BIGINT、json 保持 TEXT）见 postgres-bootstrap.ts。 */
export const SQLITE_LOGICAL_TYPE: LogicalTypeMap = SQLITE_PHYSICAL_TYPES;

export function isMemoryDatabase(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA database_list").get() as { file?: unknown } | undefined;
  return row?.file === "";
}

/**
 * 启用 WAL（文件数据库；:memory: 保持 memory 模式）并初始化 SQLite 方言存储。
 *
 * 原子 bootstrap（P1）：**preflight + 完整 DDL 在同一个事务内执行**（SQLite 的 DDL 是
 * 事务性的），任何一步失败 —— 包括中途 DDL 失败 —— 都 ROLLBACK 到 bootstrap 前状态：
 * 数据库保持「无 managed 表」，严格 preflight 不会把半成品 schema 判成不兼容库，重试即
 * 可正常初始化。BEGIN IMMEDIATE 与迁移引擎一致，作为跨进程并发的写锁：第二个并发
 * bootstrap 等待第一个 COMMIT/ROLLBACK 后再做 preflight，看到完整 schema 即跳过 DDL。
 *
 * 启动路径（严格 schema preflight，**在任何建表/建索引 DDL 之前**）：
 * 1. assertSchemaCompatible 检查数据库现状：
 *    - 无任何 managed 表（全新库 / 只有无关表）→ bootstrap 正常建库；
 *    - 已含任一 managed 表 → 要求完整 schema 与 Manifest 物理契约一致（列名/物理类型/
 *      nullable/DEFAULT/PK/FK/显式索引），否则 fail-fast，不执行任何 ALTER/补列/建索引；
 *    - 已完整一致 → 跳过 DDL（不重建，数据保留）。
 * 返回共享的 Kysely 实例；调用方负责在关闭时 destroy 它（会关闭底层 DatabaseSync）。
 */
export async function initializeDatabase(db: DatabaseSync, options: SchemaBootstrapOptions = {}): Promise<Kysely<DatabaseSchema>> {
  if (!isMemoryDatabase(db)) {
    db.exec("PRAGMA journal_mode=WAL");
  }

  const kysely = new Kysely<DatabaseSchema>({
    // Repository transactions must be BEGIN IMMEDIATE: project deletion first
    // locks the parent before listing sessions, fencing concurrent FK inserts.
    dialect: new SqliteDialect({ database: new NodeSqliteAdapter(db, true, true) }),
  });
  const databaseFile = db.prepare("PRAGMA database_list").get() as { file?: unknown } | undefined;
  registerSqliteWriteLockKey(
    kysely,
    typeof databaseFile?.file === "string" && databaseFile.file !== ""
      ? sqliteWriteLockKeyForFilename(databaseFile.file)
      : db,
  );

  const manifest = options.manifest ?? schemaManifest;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const verdict = await assertSchemaCompatible(kysely, "SQLite", SQLITE_LOGICAL_TYPE, manifest);
      if (verdict === "empty") {
        await bootstrapSchemaFromManifest(kysely, SQLITE_LOGICAL_TYPE, manifest);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 保留原始错误：回滚失败只意味着连接状态未知，绝不能掩盖 bootstrap 失败原因。
      }
      throw error;
    }
    return kysely;
  } catch (error) {
    await kysely.destroy();
    throw error;
  }
}

// 兼容既有 import：Manifest→DDL builder 流程、类型映射类型与严格兼容性 preflight 各自
// 再导出，避免既有测试 import 路径大面积改名（签名已从 2 参改为显式传入 typeMap）。
export {
  createTableFromManifest,
  createIndexFromManifest,
  bootstrapSchemaFromManifest,
  type LogicalTypeMap,
} from "./schema-builder.js";
export { assertSchemaCompatible } from "./schema-compatibility.js";
export type { SchemaCompatVerdict, SchemaDialect } from "./schema-compatibility.js";