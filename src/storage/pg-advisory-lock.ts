// PostgreSQL transaction-scoped advisory lock for the tombstone operation key.
//
// reserveConversation 对 file_operations 的 tombstone（NOT EXISTS operation_key）
// 与 session/project delete 写入同一 artifact delete outbox，二者必须在 PostgreSQL
// 上按同一个 operationKey 串行化：否则 READ COMMITTED 下 reserve 的 NOT EXISTS
// 子查询可能用旧快照读到「尚无 tombstone」，而并发 delete 随即写入同一 outbox 键，
// 使新会话复用了一个正在/已经删除的 artifact。
//
// 本模块提供一个纯函数把 operationKey 推导成稳定、确定、无敏感路径的 64 位有符号
// bigint（取 SHA-256 前 8 字节），以及一个在显式事务内执行
// `SELECT pg_advisory_xact_lock($1::bigint)` 的 helper。advisory xact lock 随事务
// COMMIT/ROLLBACK 自动释放；任何哈希碰撞只会导致不必要的串行化，绝不造成未同步访问。
//
// SQLite 不得调用本模块：SQLite 由 BEGIN IMMEDIATE + withSqliteWriteLock 承担同样的
// 串行化（见 node-sqlite-adapter.ts / sqlite-write-lock.ts）。

import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";

/**
 * 从 tombstone operationKey 推导确定性的 PostgreSQL advisory lock key。
 *
 * - 同一 operationKey 恒映射到同一 key（跨进程稳定）；
 * - key 是 signed 64-bit bigint（PG `pg_advisory_xact_lock(bigint)` 的参数范围）；
 * - 结果只含哈希，绝不回显 operationKey 或其底层原始 artifact 路径。
 */
export function pgTombstoneAdvisoryLockKey(operationKey: string): bigint {
  if (typeof operationKey !== "string" || operationKey.trim() === "") {
    throw new Error("tombstone operation key must be a non-empty string");
  }
  const digest = createHash("sha256").update(operationKey, "utf8").digest();
  let value = 0n;
  for (let index = 0; index < 8; index++) {
    value = (value << 8n) | BigInt(digest[index]!);
  }
  // 解释为 signed 64-bit（PG bigint 范围 [-2^63, 2^63-1]）。
  if (value >= 1n << 63n) value -= 1n << 64n;
  return value;
}

/**
 * 在显式事务内取得 operationKey 对应的 transaction-scoped advisory lock。
 *
 * 锁在事务 COMMIT/ROLLBACK 时自动释放。必须在同一事务内、执行 tombstone 条件更新
 * （reserveConversation）或 outbox 入队/删除（delete）**之前**调用；SQLite 路径不得调用。
 */
export async function acquireTombstoneAdvisoryXactLock(
  transaction: Kysely<DatabaseSchema>,
  operationKey: string,
): Promise<void> {
  const key = pgTombstoneAdvisoryLockKey(operationKey);
  await sql`SELECT pg_advisory_xact_lock(${key}::bigint)`.execute(transaction);
}
