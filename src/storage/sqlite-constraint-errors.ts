// SQLite 约束错误 → 存储无关应用错误的映射（仓库层专用，application 层不识别任何 SQLite 错误码）。
//
// node:sqlite 抛出的约束错误带扩展错误码 errcode：
//   - SQLITE_CONSTRAINT_PRIMARYKEY (1555)：主键冲突（如撞 projects.id / sessions.id）
//   - SQLITE_CONSTRAINT_UNIQUE     (2067)：唯一索引冲突
//   - SQLITE_CONSTRAINT_FOREIGNKEY (787)：sessions.project_id 外键冲突（项目在写入前被删除）
// 未来 PG 实现（23505 unique_violation / 23503 foreign_key_violation）在各自仓库层复用
// DuplicateIdError / ProjectForeignKeyError 做等价映射。

import { DuplicateIdError, ProjectForeignKeyError } from "../application/ports/store-errors.js";
import type { ConstraintErrorMapper } from "./constraint-error-mapper.js";

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555; // SQLITE_CONSTRAINT | (11 << 8)
const SQLITE_CONSTRAINT_UNIQUE = 2067; //     SQLITE_CONSTRAINT | (12 << 8)
const SQLITE_CONSTRAINT_FOREIGNKEY = 787; //  SQLITE_CONSTRAINT | (3 << 8)

function sqliteExtendedCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === "number" ? code : null;
}

/**
 * 解析 SQLite 唯一/主键约束错误信息中的冲突列名列表。
 * 消息形如 "UNIQUE constraint failed: <table>.col1, <table>.col2"；
 * 无法解析时返回 null（调用方不应据此映射，应保持原样抛出）。
 */
function uniqueConflictColumns(error: Error): string[] | null {
  const marker = "UNIQUE constraint failed: ";
  const index = error.message.indexOf(marker);
  if (index < 0) return null;
  const columns = error.message
    .slice(index + marker.length)
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
  return columns.length > 0 ? columns : null;
}

/**
 * 把 SQLite 实体自身 id 主键/唯一约束冲突转换为存储无关的 DuplicateIdError（保留原始 cause）抛出；
 * 仅当冲突列**恰好**为单个 `<table>.id`（如 "UNIQUE constraint failed: projects.id"）时才映射。
 * 复合唯一约束（如 "projects.owner_key, projects.id"）即使包含 `<table>.id` 也不得误转；
 * 无法解析冲突列或冲突列非该实体 id 列时原样抛出。其余错误（非约束错误、外键 787、
 * 仓库层自定义守卫错误）同样原样重新抛出，绝不吞掉。
 *
 * @param error  捕获的 SQLite 约束错误
 * @param table  实体对应的表名（如 "projects"、"sessions"），用于精确匹配 `<table>.id`
 */
export function throwDuplicateIdOrOriginal(error: unknown, table: string): never {
  const code = sqliteExtendedCode(error);
  if (
    (code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE)
    && error instanceof Error
  ) {
    const columns = uniqueConflictColumns(error);
    if (columns !== null && columns.length === 1 && columns[0] === `${table}.id`) {
      throw new DuplicateIdError(
        `数据主键/唯一约束冲突：${error.message}`,
        { cause: error },
      );
    }
  }
  throw error;
}

/** SQLite 外键约束失败（787：sessions.project_id 引用项目在写入前已被删除）。 */
export function isSqliteForeignKeyError(error: unknown): boolean {
  return sqliteExtendedCode(error) === SQLITE_CONSTRAINT_FOREIGNKEY;
}

/**
 * 把 SQLite 外键约束失败（787：sessions.project_id 引用项目在写入前已被删除）转换为
 * 存储无关的 ProjectForeignKeyError（保留原始 cause）抛出；其余错误原样重新抛出。
 */
export function throwProjectForeignKeyOrOriginal(error: unknown): never {
  if (isSqliteForeignKeyError(error)) {
    throw new ProjectForeignKeyError(
      `会话外键约束冲突：sessions.project_id 引用的项目在写入前已被删除（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  throw error;
}

/** SQLite 方言的约束错误映射器（注入给中立 Kysely Repository；PG 见 pg-constraint-errors.ts）。 */
export const sqliteConstraintErrorMapper: ConstraintErrorMapper = {
  isForeignKeyError: isSqliteForeignKeyError,
  throwDuplicateIdOrOriginal,
  throwProjectForeignKeyOrOriginal,
};