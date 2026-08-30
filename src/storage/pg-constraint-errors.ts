// PostgreSQL 约束错误（SQLSTATE）→ 存储无关应用错误的映射（PG 仓库层专用）。
//
// 与 SQLite 映射（sqlite-constraint-errors.ts）语义对齐，但只识别 PG 的 SQLSTATE：
//   - 23505 unique_violation：仅当被违反的约束是「该表自身单列 id 主键」时才转
//     DuplicateIdError（复合主键 idempotency_pk、未来唯一索引等一律原样抛出）；
//     PG 对单列列级 PRIMARY KEY 的默认约束名为 `<table>_pkey`（Manifest 单列 PK
//     无 constraintName，bootstrap 以列级 primaryKey() 生成，PG 侧即此命名）。
//   - 23503 foreign_key_violation：sessions.project_id 引用项目在写入前已被删除
//     → ProjectForeignKeyError（sessions 是当前唯一的 FK）。
// 其余数据库错误原样抛出。application 层不识别任何 PG code（23505/23503 仅在
// storage 层出现），只依赖存储无关错误。

import { DuplicateIdError, ProjectForeignKeyError } from "../application/ports/store-errors.js";
import type { ConstraintErrorMapper } from "./constraint-error-mapper.js";

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";

function pgSqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** PG 对 Manifest 单列 id 主键（列级 PRIMARY KEY）的默认约束名。 */
export function pgPrimaryKeyConstraintName(table: string): string {
  return `${table}_pkey`;
}

/** PG 23505 unique_violation 且被违反约束确为该表自身单列 id 主键（<table>_pkey）。 */
export function isPgDuplicateIdError(error: unknown, table: string): boolean {
  if (pgSqlState(error) !== PG_UNIQUE_VIOLATION || !(error instanceof Error)) return false;
  return (error as { constraint?: unknown }).constraint === pgPrimaryKeyConstraintName(table);
}

/** 23505（仅表自身单列 id 主键）→ DuplicateIdError；其余错误原样重新抛出（never 返回）。 */
export function throwPgDuplicateIdOrOriginal(error: unknown, table: string): never {
  if (isPgDuplicateIdError(error, table)) {
    throw new DuplicateIdError(
      `数据主键/唯一约束冲突：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  throw error;
}

/** PG 23503 foreign_key_violation（sessions.project_id 引用项目在写入前已被删除）。 */
export function isPgForeignKeyError(error: unknown): boolean {
  return pgSqlState(error) === PG_FOREIGN_KEY_VIOLATION;
}

/** 23503 → ProjectForeignKeyError；其余错误原样重新抛出（never 返回）。 */
export function throwPgProjectForeignKeyOrOriginal(error: unknown): never {
  if (isPgForeignKeyError(error)) {
    throw new ProjectForeignKeyError(
      `会话外键约束冲突：sessions.project_id 引用的项目在写入前已被删除（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  throw error;
}

/** PG 方言的约束错误映射器（注入给中立 Kysely Repository）。 */
export const pgConstraintErrorMapper: ConstraintErrorMapper = {
  isForeignKeyError: isPgForeignKeyError,
  throwDuplicateIdOrOriginal: throwPgDuplicateIdOrOriginal,
  throwProjectForeignKeyOrOriginal: throwPgProjectForeignKeyOrOriginal,
};