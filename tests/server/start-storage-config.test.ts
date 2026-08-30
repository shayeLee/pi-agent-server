// 存储方言配置解析单测（工作包 C；fail-fast，不静默回退）：
// - 默认（未配置 storageDialect）→ sqlite（向后兼容）；
// - 显式 "sqlite" → sqlite；即便同时给了 databaseUrl 也不启用 PG（绝不隐式回退/升级）；
// - "postgres" → 必须非空 databaseUrl，缺失/空白 fail-fast；
// - 未知方言值 fail-fast。

import { describe, it, expect } from "vitest";
import { resolveStorageConfig, type ResolvedStorage } from "../../src/server/start.js";

describe("resolveStorageConfig（SQLite 默认向后兼容 + PG 显式 fail-fast）", () => {
  it("未配置 storageDialect → sqlite，dbPath 取默认", () => {
    const resolved = resolveStorageConfig({}, "/srv/data/app.db");
    expect(resolved).toEqual({ dialect: "sqlite", dbPath: "/srv/data/app.db" });
  });

  it("显式 storageDialect=sqlite → sqlite（dbPath 覆盖默认）", () => {
    const resolved = resolveStorageConfig({ storageDialect: "sqlite", dbPath: "/custom/app.db" }, "/default/db");
    expect(resolved).toEqual({ dialect: "sqlite", dbPath: "/custom/app.db" });
  });

  it("databaseUrl 单独提供（未设 storageDialect=postgres）仍走 sqlite（向后兼容，绝不隐式启用 PG）", () => {
    const resolved = resolveStorageConfig({ databaseUrl: "postgres://user@host/db" }, "/srv/data/app.db");
    expect(resolved).toEqual({ dialect: "sqlite", dbPath: "/srv/data/app.db" });
  });

  it("storageDialect=postgres + databaseUrl → postgres", () => {
    const resolved = resolveStorageConfig(
      { storageDialect: "postgres", databaseUrl: "postgres://user:pass@host:5432/db" },
      "/srv/data/app.db",
    );
    expect(resolved).toEqual({ dialect: "postgres", databaseUrl: "postgres://user:pass@host:5432/db" });
  });

  it("storageDialect=postgres 但缺 databaseUrl → fail-fast（拒绝启动，不静默回退 SQLite）", () => {
    expect(() => resolveStorageConfig({ storageDialect: "postgres" }, "/srv/data/app.db")).toThrow(
      /databaseUrl.*PI_DATABASE_URL/,
    );
    expect(() => resolveStorageConfig({ storageDialect: "postgres", databaseUrl: "" }, "/srv/data/app.db")).toThrow(
      /databaseUrl.*PI_DATABASE_URL/,
    );
    expect(() => resolveStorageConfig({ storageDialect: "postgres", databaseUrl: "   " }, "/srv/data/app.db")).toThrow(
      /databaseUrl.*PI_DATABASE_URL/,
    );
  });

  it("未知方言值 → fail-fast（仅支持 sqlite / postgres，不静默回退）", () => {
    for (const bad of ["mysql", "mariadb", "oracle", "bogus"]) {
      expect(() => resolveStorageConfig({ storageDialect: bad as never }, "/srv/data/app.db")).toThrow(
        /未知存储方言/,
      );
    }
  });

  it("空串/空白 storageDialect → 归一化为未配置（SQLite 默认）", () => {
    // 进程入口 PI_STORAGE_DIALECT= 或 PI_STORAGE_DIALECT="   " 不应 fail-fast
    expect(resolveStorageConfig({ storageDialect: "" as never }, "/srv/data/app.db")).toEqual({
      dialect: "sqlite",
      dbPath: "/srv/data/app.db",
    });
    expect(resolveStorageConfig({ storageDialect: "   " as never }, "/srv/data/app.db")).toEqual({
      dialect: "sqlite",
      dbPath: "/srv/data/app.db",
    });
  });

  it("未知非空值（含带空白的未知值）仍 fail-fast", () => {
    for (const bad of ["mysql", "mariadb", "oracle", "bogus", " sqlite ", "postgres "]) {
      expect(() => resolveStorageConfig({ storageDialect: bad as never }, "/srv/data/app.db")).toThrow(
        /未知存储方言/,
      );
    }
  });

  it("返回类型区分 sqlite/postgres（联合类型可穷举）", () => {
    const r1 = resolveStorageConfig({}, "/d.db") as ResolvedStorage;
    const r2 = resolveStorageConfig({ storageDialect: "postgres", databaseUrl: "postgres://u@p/d" }, "/d.db") as ResolvedStorage;
    expect(r1.dialect === "sqlite" ? r1.dbPath : r1.databaseUrl).toBe("/d.db");
    expect(r2.dialect === "postgres" ? r2.databaseUrl : r2.dbPath).toBe("postgres://u@p/d");
  });
});