import { describe, expect, it } from "vitest";
import { throwDuplicateIdOrOriginal, throwProjectForeignKeyOrOriginal } from "../src/storage/sqlite-constraint-errors.js";
import { DuplicateIdError, ProjectForeignKeyError } from "../src/application/ports/store-errors.js";

function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { errcode });
}

describe("throwDuplicateIdOrOriginal（SQLite 约束错误 → 存储无关错误映射）", () => {
  it("1555 主键冲突且冲突列恰为单列 <table>.id 时转为 DuplicateIdError 并保留 cause", () => {
    const err = sqliteError("UNIQUE constraint failed: projects.id", 1555);
    try {
      throwDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("应抛 DuplicateIdError");
    } catch (caught) {
      expect(caught).toBeInstanceOf(DuplicateIdError);
      expect((caught as DuplicateIdError).cause).toBe(err);
    }
  });

  it("2067 唯一冲突且冲突列恰为单列 <table>.id 时转为 DuplicateIdError", () => {
    const err = sqliteError("UNIQUE constraint failed: sessions.id", 2067);
    try {
      throwDuplicateIdOrOriginal(err, "sessions");
      expect.unreachable("应抛 DuplicateIdError");
    } catch (caught) {
      expect(caught).toBeInstanceOf(DuplicateIdError);
      expect((caught as DuplicateIdError).cause).toBe(err);
    }
  });

  it("复合唯一约束消息包含 <table>.id 时不得误转（如 projects.owner_key, projects.id）", () => {
    // 尽管消息含 "projects.id" 子串，冲突列是两列（owner_key + id），必须原样抛出
    const err = sqliteError("UNIQUE constraint failed: projects.owner_key, projects.id", 2067);
    try {
      throwDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("不应转 DuplicateIdError");
    } catch (caught) {
      expect(caught).not.toBeInstanceOf(DuplicateIdError);
      expect(caught).toBe(err); // 原错误对象原样抛出
    }
  });

  it("复合唯一约束消息（两个非 id 列）原样抛出", () => {
    const err = sqliteError("UNIQUE constraint failed: projects.owner_key, projects.name", 2067);
    try {
      throwDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("不应转 DuplicateIdError");
    } catch (caught) {
      expect(caught).not.toBeInstanceOf(DuplicateIdError);
      expect(caught).toBe(err);
    }
  });

  it("单列但非 id 列的唯一冲突（projects.owner_key）原样抛出", () => {
    const err = sqliteError("UNIQUE constraint failed: projects.owner_key", 2067);
    try {
      throwDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("不应转 DuplicateIdError");
    } catch (caught) {
      expect(caught).not.toBeInstanceOf(DuplicateIdError);
      expect(caught).toBe(err);
    }
  });

  it("消息无法解析冲突列时原样抛出（不误转）", () => {
    const err = sqliteError("weird failure without marker", 1555);
    try {
      throwDuplicateIdOrOriginal(err, "projects");
      expect.unreachable("不应转 DuplicateIdError");
    } catch (caught) {
      expect(caught).not.toBeInstanceOf(DuplicateIdError);
      expect(caught).toBe(err);
    }
  });

  it("非约束错误（无 errcode 或非 1555/2067）原样抛出", () => {
    const plain = new Error("仓库守卫异常");
    try {
      throwDuplicateIdOrOriginal(plain, "projects");
      expect.unreachable("应原样抛出");
    } catch (caught) {
      expect(caught).toBe(plain);
    }
    const fk = sqliteError("FOREIGN KEY constraint failed", 787);
    try {
      throwDuplicateIdOrOriginal(fk, "sessions");
      expect.unreachable("应原样抛出");
    } catch (caught) {
      expect(caught).not.toBeInstanceOf(DuplicateIdError);
      expect(caught).toBe(fk);
    }
  });
});

describe("throwProjectForeignKeyOrOriginal（FK 787 → ProjectForeignKeyError）", () => {
  it("errcode 787 转为存储无关 ProjectForeignKeyError 并保留 cause", () => {
    const err = sqliteError("FOREIGN KEY constraint failed", 787);
    try {
      throwProjectForeignKeyOrOriginal(err);
      expect.unreachable("应抛 ProjectForeignKeyError");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProjectForeignKeyError);
      expect((caught as ProjectForeignKeyError).cause).toBe(err);
      expect((caught as Error).message).toMatch(/外键/);
    }
  });

  it("非 787（如 1555/2067/无 errcode）原样抛出", () => {
    for (const err of [
      sqliteError("UNIQUE constraint failed: sessions.id", 1555),
      sqliteError("UNIQUE constraint failed: sessions.title", 2067),
      new Error("仓库守卫异常"),
    ]) {
      try {
        throwProjectForeignKeyOrOriginal(err);
        expect.unreachable("应原样抛出");
      } catch (caught) {
        expect(caught).not.toBeInstanceOf(ProjectForeignKeyError);
        expect(caught).toBe(err);
      }
    }
  });
});