// SQLite 空数据库初始化（工作包 B/C：消费运行时 Schema Manifest 生成 SQLite 方言 bootstrap）：
//   - 本文件是 SQLite 方言入口：逻辑列类型 → SQLite 物理类型映射（SQLITE_LOGICAL_TYPE）+ WAL 行为，
//     实际的 Manifest→DDL 流程在 schema-builder.ts（与 PG bootstrap 共用，Manifest 仍是唯一来源）；
//   - WAL（文件数据库启用，:memory: 跳过，与外键/5s timeout 选项在 start.ts 的 DatabaseSync
//     创建时一并设置）；
//   - 表/列/主键/外键/索引的全部声明来自 schema-manifest.ts 的 schemaManifest（唯一来源）；
//   - migration-head 边界：全新库按最新 manifest 原子建表，并同事务写入完整 canonical ledger；
//     已含 managed 表但无 ledger、或 ledger 未到 head 的库一律 fail-fast。历史升级只由 offline migrate 执行；
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
import { schemaManifest, type SchemaManifest } from "./schema-manifest.js";
import { assertSqliteMigrationLedgerContract, MIGRATION_LEDGER_TABLE, runSqliteMigrations } from "./migration-engine.js";
import { migrationChecksum, migrationDefinitions, SQLITE_PHYSICAL_TYPES } from "./migration-manifest.js";
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
 * 仅用于离线/test bootstrap：服务启动必须先经 migration gate verify，不会调用本函数创建基线。
 * 原子 bootstrap（P1）：**ledger 门禁 + preflight + 完整 DDL 在同一个事务内执行**（SQLite 的 DDL 是
 * 事务性的），任何一步失败 —— 包括中途 DDL 失败 —— 都 ROLLBACK 到 bootstrap 前状态：
 * 数据库保持「无 managed 表」，严格 preflight 不会把半成品 schema 判成不兼容库，重试即
 * 可正常初始化。BEGIN IMMEDIATE 与迁移引擎一致，作为跨进程并发的写锁：第二个并发
 * bootstrap 等待第一个 COMMIT/ROLLBACK 后再做 preflight，看到完整 schema 即跳过 DDL。
 *
 * migration-head ledger 门禁（在任何建表/建索引 DDL 之前）：
 * 1. 库中已存在 schema_migrations：只接受所有已发布迁移的完整 canonical ledger；落后于 head
 *    或带未知版本/错误 checksum 的 ledger 一律 fail-fast，历史升级由 offline migrate 完成；
 * 2. 无 ledger 但已含任一 managed 表 → legacy 库，fail-fast（专有消息），绝不采用；
 * 3. 全新库（无 ledger、无 managed 表）→ bootstrap 建最新 manifest 的全部表/索引，并在**同一事务**
 *    写入完整 canonical migration ledger（后续 verify/apply 均可直接通过）。
 *
 * 启动路径（strict schema preflight，**在任何建表/建索引 DDL 之前**）：
 * - 无任何 managed 表（全新库 / 只有无关表）→ bootstrap 正常建库 + 完整 migration-head ledger；
 * - 已含任一 managed 表 → 要求完整 schema 与 Manifest 物理契约一致（列名/物理类型/
 *   nullable/DEFAULT/PK/FK/显式索引），否则 fail-fast，不执行任何 ALTER/补列/建索引；
 * - 已完整一致 → 跳过 DDL（不重建，数据保留）。
 * 返回共享的 Kysely 实例；调用方负责在关闭时 destroy 它（会关闭底层 DatabaseSync）。
 */
export function createDatabaseKysely(db: DatabaseSync): Kysely<DatabaseSchema> {
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
  return kysely;
}

/**
 * 服务启动专用：严格只读 verify 初始化，**绝不 bootstrap**（不建表/索引/baseline ledger）。
 * 与 initializeDatabase 的差异：库为空/无 ledger/落后于 migration head 一律 fail-fast；
 * 唯一通过条件是「已经在 head 且物理 schema 与 Manifest 契约一致」。
 * 同一数据库连接既做 verify，也作为 Repository 使用的 Kysely —— 消除「门禁连接 + bootstrap
 * 连接」两连接/TOCTOU bootstrap 风险。
 */
export async function initializeDatabaseVerifyOnly(db: DatabaseSync): Promise<Kysely<DatabaseSchema>> {
  if (!isMemoryDatabase(db)) {
    db.exec("PRAGMA journal_mode=WAL");
  }

  const kysely = createDatabaseKysely(db);
  try {
    // 直接用迁移引擎的严格 verify：空库/legacy/落后库都抛错，且不执行任何 DDL。
    await runSqliteMigrations(db, { mode: "verify" });
    return kysely;
  } catch (error) {
    // verify 在单独的迁移 Kysely 上跑，仓库 Kysely 尚未执行任何查询（驱动未 init），
    // destroy 不会关闭底层 DatabaseSync；这里直接关闭它，确保失败路径不泄漏连接。
    try { await kysely.destroy(); } catch { /* 保留原始错误 */ }
    try { db.close(); } catch { /* 已被 destroy/其他路径关闭，忽略 */ }
    throw error;
  }
}

export async function initializeDatabase(db: DatabaseSync, options: SchemaBootstrapOptions = {}): Promise<Kysely<DatabaseSchema>> {
  if (!isMemoryDatabase(db)) {
    db.exec("PRAGMA journal_mode=WAL");
  }

  const kysely = createDatabaseKysely(db);

  const manifest = options.manifest ?? schemaManifest;
  const migrations = migrationDefinitions;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      // migration-head ledger 门禁：先于任何 DDL 判定 legacy / incomplete ledger / 正常状态.
      if (sqliteTableExists(db, MIGRATION_LEDGER_TABLE)) {
        // Reuse migration-engine's strict physical ledger contract before reading/adopting its row.
        assertSqliteMigrationLedgerContract(db);
        assertCanonicalMigrationLedger(db, migrations);
        const verdict = await assertSchemaCompatible(kysely, "SQLite", SQLITE_LOGICAL_TYPE, manifest);
        if (verdict === "empty") {
          throw new Error(`schema migration ledger: ledger exists but no managed table is present; refusing to adopt a corrupt legacy state`);
        }
        // "complete"：跳过 DDL（不重建，数据保留）。
      } else if (sqliteManagedTableExists(db, manifest)) {
        throw new Error(
          `schema migration ledger: managed tables exist without the migration ledger; this is a legacy database and bootstrap adoption is forbidden — ` +
          `start from an empty database and apply migrations (pnpm migrate -- --apply)`,
        );
      } else {
        const verdict = await assertSchemaCompatible(kysely, "SQLite", SQLITE_LOGICAL_TYPE, manifest);
        if (verdict === "empty") {
          await bootstrapSchemaFromManifest(kysely, SQLITE_LOGICAL_TYPE, manifest);
          createSqliteLedgerTable(db);
          for (const migration of migrations) insertSqliteLedgerRow(db, migration);
        }
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

function sqliteTableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { present: number }
    | undefined;
  return row !== undefined;
}

function sqliteManagedTableExists(db: DatabaseSync, manifest: SchemaManifest): boolean {
  const names = new Set(manifest.tables.map((table) => table.name));
  return [...names].some((name) => sqliteTableExists(db, name));
}

/** 只接受恰好一条 canonical 基线行（version=0 / initial-schema / 当前 golden checksum）。 */
function assertCanonicalMigrationLedger(db: DatabaseSync, migrations: typeof migrationDefinitions): void {
  const rows = db.prepare(
    `SELECT version, name, checksum FROM ${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)} ORDER BY version`,
  ).all() as Array<{ version: unknown; name: unknown; checksum: unknown }>;
  const canonical = rows.length === migrations.length && migrations.every((migration, index) => {
    const row = rows[index];
    return row?.version === migration.version && row.name === migration.name && row.checksum === migrationChecksum(migration);
  });
  if (!canonical) {
    throw new Error(
      "schema migration ledger: bootstrap only accepts a complete canonical migration head; " +
      "apply pending migrations with the offline migration runner before bootstrap",
    );
  }
}

function quoteSqliteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`migration: unsafe identifier '${name}'`);
  return `"${name}"`;
}

/** 与迁移引擎 createSqliteLedger 完全相同的物理契约（engine 的 readSqliteLedger 严格校验此形态）。 */
function createSqliteLedgerTable(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE ${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)} (\n` +
      "  version INTEGER PRIMARY KEY NOT NULL,\n" +
      "  name TEXT UNIQUE NOT NULL,\n" +
      "  checksum TEXT NOT NULL,\n" +
      "  applied_at INTEGER NOT NULL\n" +
      ")",
  );
}

function insertSqliteLedgerRow(db: DatabaseSync, migration: (typeof migrationDefinitions)[number]): void {
  db.prepare(
    `INSERT INTO ${quoteSqliteIdent(MIGRATION_LEDGER_TABLE)} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
  ).run(migration.version, migration.name, migrationChecksum(migration), Date.now());
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