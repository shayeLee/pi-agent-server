// PG 约束错误（SQLSTATE）→ 存储无关错误映射单测（工作包 C，无需真实 PG）：
// 直接构造带 code/constraint 的类 pg DatabaseError 对象，验证同一套
// throwPgDuplicateIdOrOriginal / throwPgProjectForeignKeyOrOriginal / isPgForeignKeyError
// 只把预期的 SQLSTATE 转成 DuplicateIdError / ProjectForeignKeyError，其余错误原样抛出。

import { describe, expect, it } from "vitest";
import {
  pgConstraintErrorMapper,
  throwPgDuplicateIdOrOriginal,
  throwPgProjectForeignKeyOrOriginal,
  isPgForeignKeyError,
  isPgDuplicateIdError,
  pgPrimaryKeyConstraintName,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
} from "../../src/storage/pg-constraint-errors.js";
import { DuplicateIdError, ProjectForeignKeyError } from "../../src/application/ports/store-errors.js";

/** 构造类 pg DatabaseError 对象（带 SQLSTATE code / constraint 名）。 */
function pgError(message: string, fields: { code?: string; constraint?: string } = {}): Error {
  return Object.assign(new Error(message), fields);
}

describe("throwPgDuplicateIdOrOriginal（23505 且约束恰为表自身单列 id 主键 → DuplicateIdError）", () => {
  it("projects_pkey 冲突（23505）→ DuplicateIdError 并保留 cause", () => {
    const err = pgError('duplicate key value violates unique constraint "projects_pkey"', {
      code: PG_UNIQUE_VIOLATION,
      constraint: "projects_pkey",
    });
    try {
      throwPgDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("应抛 DuplicateIdError");
    } catch (caught) {
      expect(caught).toBeInstanceOf(DuplicateIdError);
      expect((caught as DuplicateIdError).cause).toBe(err);
    }
  });

  it("sessions_pkey 冲突（23505）→ DuplicateIdError", () => {
    const err = pgError('duplicate key value violates unique constraint "sessions_pkey"', {
      code: PG_UNIQUE_VIOLATION,
      constraint: "sessions_pkey",
    });
    try {
      throwPgDuplicateIdOrOriginal(err, "sessions");
      expect.unreachable("应抛 DuplicateIdError");
    } catch (caught) {
      expect(caught).toBeInstanceOf(DuplicateIdError);
    }
  });

  it("复合主键 idempotency_pk 冲突（23505）不转 DuplicateIdError（非表自身单列 id）", () => {
    const err = pgError('duplicate key value violates unique constraint "idempotency_pk"', {
      code: PG_UNIQUE_VIOLATION,
      constraint: "idempotency_pk",
    });
    try {
      throwPgDuplicateIdOrOriginal(err, "idempotency");
      expect.unreachable("不应转 DuplicateIdError");
    } catch (caught) {
      expect(caught).not.toBeInstanceOf(DuplicateIdError);
      expect(caught).toBe(err);
    }
  });

  it("非表自身 id 主键的其他 23505（如未来唯一索引）原样抛出（不污染有界重试语义）", () => {
    const err = pgError('duplicate key value violates unique constraint "projects_name_key"', {
      code: PG_UNIQUE_VIOLATION,
      constraint: "projects_name_key",
    });
    try {
      throwPgDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("不应转 DuplicateIdError");
    } catch (caught) {
      expect(caught).not.toBeInstanceOf(DuplicateIdError);
      expect(caught).toBe(err);
    }
  });

  it("23505 但无 constraint 字段 → 原样抛出（无法确证是自身单列 id 主键）", () => {
    const err = pgError("duplicate key value violates unique constraint", {
      code: PG_UNIQUE_VIOLATION,
    });
    try {
      throwPgDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("不应转 DuplicateIdError");
    } catch (caught) {
      expect(caught).toBe(err);
    }
  });

  it("非 23505 错误（42P01/22P02/28P01/普通错误）原样抛出", () => {
    for (const err of [
      pgError('relation "projects" does not exist', { code: "42P01" }),
      pgError("invalid text representation", { code: "22P02" }),
      pgError("password authentication failed", { code: "28P01" }),
      new Error("仓库守卫异常"),
      pgError('foreign key violation', { code: PG_FOREIGN_KEY_VIOLATION }),
    ]) {
      try {
        throwPgDuplicateIdOrOriginal(err, "projects");
        expect.unreachable("应原样抛出");
      } catch (caught) {
        expect(caught).not.toBeInstanceOf(DuplicateIdError);
        expect(caught).toBe(err);
      }
    }
  });
});

describe("throwPgProjectForeignKeyOrOriginal（23503 → ProjectForeignKeyError）", () => {
  it("sessions_project_id_fk 23503 → ProjectForeignKeyError 并保留 cause", () => {
    const err = pgError(
      'insert or update on table "sessions" violates foreign key constraint "sessions_project_id_fk"',
      { code: PG_FOREIGN_KEY_VIOLATION, constraint: "sessions_project_id_fk" },
    );
    try {
      throwPgProjectForeignKeyOrOriginal(err);
      expect.unreachable("应抛 ProjectForeignKeyError");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProjectForeignKeyError);
      expect((caught as Error).message).toMatch(/外键/);
      expect((caught as ProjectForeignKeyError).cause).toBe(err);
    }
  });

  it("非 23503（23505/42P01/无 code）原样抛出", () => {
    for (const err of [
      pgError('duplicate key value violates unique constraint "sessions_pkey"', {
        code: PG_UNIQUE_VIOLATION,
        constraint: "sessions_pkey",
      }),
      pgError('relation "sessions" does not exist', { code: "42P01" }),
      new Error("仓库守卫异常"),
    ]) {
      try {
        throwPgProjectForeignKeyOrOriginal(err);
        expect.unreachable("应原样抛出");
      } catch (caught) {
        expect(caught).not.toBeInstanceOf(ProjectForeignKeyError);
        expect(caught).toBe(err);
      }
    }
  });
});

describe("isPgDuplicateIdError / isPgForeignKeyError / pgPrimaryKeyConstraintName / mapper 组装", () => {
  it("isPgDuplicateIdError 只认 23505 + 表自身 <table>_pkey", () => {
    expect(
      isPgDuplicateIdError(
        pgError("dup", { code: PG_UNIQUE_VIOLATION, constraint: "projects_pkey" }),
        "projects",
      ),
    ).toBe(true);
    expect(
      isPgDuplicateIdError(
        pgError("dup", { code: PG_UNIQUE_VIOLATION, constraint: "projects_name_key" }),
        "projects",
      ),
    ).toBe(false);
    expect(isPgDuplicateIdError(pgError("dup", { code: PG_FOREIGN_KEY_VIOLATION }), "projects")).toBe(false);
  });

  it("pgPrimaryKeyConstraintName 派生 PG 单列列级主键默认约束名", () => {
    expect(pgPrimaryKeyConstraintName("projects")).toBe("projects_pkey");
    expect(pgPrimaryKeyConstraintName("sessions")).toBe("sessions_pkey");
  });

  it("isForeignKeyError 只认 23503", () => {
    expect(isPgForeignKeyError(pgError("fk", { code: PG_FOREIGN_KEY_VIOLATION }))).toBe(true);
    expect(isPgForeignKeyError(pgError("dup", { code: PG_UNIQUE_VIOLATION }))).toBe(false);
    expect(isPgForeignKeyError(new Error("plain"))).toBe(false);
  });

  it("pgConstraintErrorMapper 组装与各函数一致（注入给中立 Repository 的契约）", () => {
    expect(pgConstraintErrorMapper.isForeignKeyError).toBe(isPgForeignKeyError);
    expect(pgConstraintErrorMapper.throwDuplicateIdOrOriginal).toBe(throwPgDuplicateIdOrOriginal);
    expect(pgConstraintErrorMapper.throwProjectForeignKeyOrOriginal).toBe(throwPgProjectForeignKeyOrOriginal);
  });
});