// PostgreSQL 空数据库初始化（工作包 C）：从同一个运行时 Schema Manifest（唯一来源）
// 生成 PG 方言 bootstrap，与 SQLite bootstrap（bootstrap.ts）共用 schema-builder.ts 流程。
//
// PG 逻辑类型映射（Manifest → PG DDL）：
//   - uuid    → UUID
//   - text    → TEXT
//   - integer → BIGINT（毫秒时间戳；与 SQLite 的 integer 语义一致，PG 侧统一 BIGINT）
//   - bigint  → BIGINT
//   - json    → TEXT（**非 JSONB**，与本阶段 JSON text 往返语义一致）
//
// int8 读回：pg 默认把 BIGINT 读为 string，本模块组装 per-pool CustomTypes
// （createPgInt8SafeTypes，见 pg-int8.ts）把 int8 读为安全 JS number，超出
// Number.MAX_SAFE_INTEGER 显式失败（不静默丢精度）。
//
// Pool 生命周期：createPostgresPool 创建 Pool；Kysely 的 PostgresDialect.destroy()
// 会调用 pool.end()（Kysely PostgresDriver.destroy），故 start.ts 复用既有的
// createIdempotentStorageCloser：closeStorage → kysely.destroy() → pool 释放。
// bootstrap 失败时本文件先 destroy（同时也释放 Pool）再抛原始错误。

import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import {
  bootstrapSchemaFromManifest,
  type LogicalTypeMap,
  type SchemaBootstrapOptions,
} from "./schema-builder.js";
import { assertSchemaCompatible } from "./schema-compatibility.js";
import { createPgInt8SafeTypes } from "./pg-int8.js";
import type { DatabaseSchema } from "./db-schema.js";
import { schemaManifest } from "./schema-manifest.js";
import { POSTGRES_PHYSICAL_TYPES } from "./migration-manifest.js";

/** 逻辑列类型 → PostgreSQL 物理类型（uuid→UUID、text/json→TEXT、integer/bigint→BIGINT）。 */
export const POSTGRES_LOGICAL_TYPE: LogicalTypeMap = POSTGRES_PHYSICAL_TYPES;

/**
 * Bootstrap 并发锁的 key 前缀（advisory lock 与迁移引擎的 POSTGRES_MIGRATION_LOCK_KEY
 * 不同域）。锁以 `key || current_database()` 键控：并发 bootstrap 同一数据库互相串行，
 * 不同数据库互不阻塞。
 */
export const POSTGRES_BOOTSTRAP_LOCK_SCOPE = "pi-agent-server:pg-schema-bootstrap";

/** 创建带 int8 安全解析的 PG Pool（连接按需建立；连接串由调用方提供）。 */
export interface PostgresPoolTimeouts {
  /** Milliseconds to wait for an idle connection before failing (0 = no timeout). */
  readonly connectionTimeoutMillis?: number;
  /** Per-connection statement_timeout in ms; bounds any single hung query. */
  readonly statementTimeoutMs?: number;
  /** Per-query driver timeout in ms; bounds a stuck query independent of the server. */
  readonly queryTimeoutMs?: number;
}

/**
 * 创建带 int8 安全解析的 PG Pool。可选的 timeouts 仅用于离线 gate（pre-migration
 * backup / migrate CLI），让每个外部查询有界；服务端正常路径不传，保持原有无界语义。
 */
export function createPostgresPool(connectionString: string, timeouts?: PostgresPoolTimeouts): Pool {
  return new Pool({
    connectionString,
    types: createPgInt8SafeTypes(),
    connectionTimeoutMillis: timeouts?.connectionTimeoutMillis ?? 0,
    ...(timeouts?.statementTimeoutMs !== undefined ? { statement_timeout: timeouts.statementTimeoutMs } : {}),
    ...(timeouts?.queryTimeoutMs !== undefined ? { query_timeout: timeouts.queryTimeoutMs } : {}),
  });
}

/** 用 PG 方言包装 Kysely 实例（不建表）。 */
export function createPostgresKysely(pool: Pool): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * PG 空库 bootstrap：按 Manifest 幂等创建当前 schema（表/列/主键/外键/索引）。
 *
 * 原子 bootstrap（P1）：**preflight + 完整 DDL 在同一个 transaction 内执行**（PG 的 DDL
 * 是事务性的），中途 DDL 失败由事务自动 ROLLBACK，数据库保持空库、严格 preflight 不会把
 * 半成品 schema 判成不兼容，重试即可。事务内先取 transaction-scoped advisory lock
 * （按当前数据库名前缀键控，不跨库互锁），把并发 bootstrap 串行化：后到者等待前者
 * COMMIT/ROLLBACK（xact 锁自动释放）之后再 preflight，看到完整 schema 即跳过 DDL。
 *
 * 启动路径（严格 schema preflight，**在任何建表/建索引 DDL 之前**）：
 * 1. assertSchemaCompatible 检查数据库现状：
 *    - 无任何 managed 表（全新 schema / 只有无关表）→ bootstrap 正常建库；
 *    - 已含任一 managed 表 → 要求完整 schema 与 Manifest 物理契约一致（列名/物理类型/
 *      nullable/DEFAULT/PK/FK/显式索引），否则 fail-fast，不执行任何 ALTER/补列/建索引；
 *    - 已完整一致 → 跳过 DDL（不重建）。
 * 失败路径先 destroy（释放 Pool）再抛原始错误。
 */
export async function initializePostgresDatabase(pool: Pool, options: SchemaBootstrapOptions = {}): Promise<Kysely<DatabaseSchema>> {
  const kysely = createPostgresKysely(pool);
  try {
    const manifest = options.manifest ?? schemaManifest;
    await kysely.transaction().execute(async (transaction) => {
      const trx = transaction as unknown as Kysely<DatabaseSchema>;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${POSTGRES_BOOTSTRAP_LOCK_SCOPE} || current_database()))`.execute(trx);
      const verdict = await assertSchemaCompatible(trx, "PostgreSQL", POSTGRES_LOGICAL_TYPE, manifest);
      if (verdict === "empty") {
        await bootstrapSchemaFromManifest(trx, POSTGRES_LOGICAL_TYPE, manifest);
      }
    });
    return kysely;
  } catch (error) {
    await kysely.destroy();
    throw error;
  }
}