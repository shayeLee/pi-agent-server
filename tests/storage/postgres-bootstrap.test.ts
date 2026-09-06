// PG bootstrap 生命周期单测（工作包 C；**不发起任何真实网络连接**）：
// - kysely.destroy() → Kysely PostgresDriver.destroy → pool.end()（createIdempotentStorageCloser
//   的既有 closer 调用 kysely.destroy 即释放 Pool，不依赖未验证假设）；
// - bootstrapSchemaFromManifest 失败路径：initializePostgresDatabase 先 destroy（释放 Pool）
//   再抛原始错误（与 SQLite initializeDatabase 的失败收尾语义一致）；
// - createPostgresPool 组装 per-pool int8 安全 types 配置。
// 真实 PG 建库/查询行为由 tests/postgres（PI_TEST_PG_URL 门控）集成测试覆盖。

import { describe, it, expect, vi } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import {
  createPostgresKysely,
  createPostgresPool,
  initializePostgresDatabase,
  initializePostgresDatabaseVerifyOnly,
} from "../../src/storage/postgres-bootstrap.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import type { SchemaManifest } from "../../src/storage/schema-manifest.js";
import type { Pool } from "pg";

describe("PG Pool 生命周期（无网络：用 fake Pool/Client 驱动完整 init→query→destroy 链）", () => {
  it("kysely.destroy() 经 PostgresDriver.destroy 释放 Pool（pool.end 恰一次）", async () => {
    // fake Pool（不真正建连）：Kysely 的 RuntimeDriver 只有在执行过查询后 destroy 才会真正
    // 走到 PostgresDriver.destroy；生产路径 bootstrap 必然先跑建表查询，本用例用一次 SELECT
    // 驱动完整链路，验证「closer → kysely.destroy() → pool.end()」。
    const end = vi.fn(() => Promise.resolve());
    const client = {
      query: () => Promise.resolve({ command: "SELECT", rowCount: 0, rows: [], fields: [] }),
      release: () => {},
    };
    const pool = {
      Client: undefined,
      options: {},
      connect: () => Promise.resolve(client),
      end,
    } as unknown as Pool;

    const kysely = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await sql`select 1`.execute(kysely); // 初始化并真实跑一次查询（不联网）
    await kysely.destroy();
    expect(end).toHaveBeenCalledTimes(1);
    // 幂等：再次 destroy 不再调用 pool.end（Kysely RuntimeDriver 幂等）
    await kysely.destroy();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("initializePostgresDatabase 失败路径：先 destroy（释放 Pool）再抛原始错误", async () => {
    // fake Pool 的 connect 直接拒绝：bootstrapSchemaFromManifest 的首次查询必然失败，
    // 无需真实 PG/网络即可驱动失败收尾路径。
    const end = vi.fn(() => Promise.resolve());
    const fakePool = {
      options: {},
      connect: () => Promise.reject(new Error("模拟 PG 连接失败")),
      end,
    } as unknown as Pool;

    const kysely = createPostgresKysely(fakePool);
    await expect(initializePostgresDatabase(fakePool)).rejects.toThrow("模拟 PG 连接失败");
    // 失败路径确实执行了 destroy → pool.end()
    expect(end).toHaveBeenCalledTimes(1);
    void kysely;
  });

  it("createPostgresPool 组装了 per-pool int8 安全 types（OID 20 → parsePgInt8）", () => {
    const pool = createPostgresPool("postgres://127.0.0.1:1/pg-pool-types");
    // Pool 配置中的 types.getTypeParser(20) 即安全 int8 解析器
    const types = (pool as unknown as { options: { types?: { getTypeParser?: (oid: number) => (value: string) => unknown } } })
      .options.types;
    expect(types).toBeDefined();
    const parser = types!.getTypeParser!(20);
    expect(parser("1718000000000")).toBe(1718000000000);
    expect(() => parser("9223372036854775807")).toThrow(/超出 JS 安全整数范围/);
    // 非 int8（int4）仍用默认解析
    expect(types!.getTypeParser!(23)("42")).toBe(42);
  });
});

// -------------------------------------------------------------------------
// 原子 bootstrap（P1）：preflight + 完整 DDL 在同一个 transaction 内执行；事务先取
// transaction-scoped advisory lock（按当前数据库键控）。中途 DDL 失败 → ROLLBACK（绝无
// COMMIT），数据库保持空库；重试（生产 Manifest）成功并 COMMIT。
// -------------------------------------------------------------------------

/** 注入一份 DDL 中途必失败的 Manifest（索引引用不存在的列；raw 字面量绕过 defineSchema 校验）。 */
function brokenBootstrapManifest(): SchemaManifest {
  return {
    tables: [
      {
        name: "t_first",
        columns: [{ name: "id", type: "uuid", nullable: false }],
        primaryKey: { columns: ["id"] },
        foreignKeys: [],
        indexes: [],
      },
      {
        name: "t_second",
        columns: [{ name: "id", type: "uuid", nullable: false }],
        primaryKey: { columns: ["id"] },
        foreignKeys: [],
        indexes: [{ name: "idx_t_second_missing", columns: [{ name: "missing_column" }] }],
      },
    ],
  };
}

/** fake Pool/Client：记录全部 SQL，可指定「CREATE INDEX 必失败」以注入 DDL 中途失败。 */
function recordingPool(options: { failOnCreateIndex?: boolean } = {}): {
  pool: Pool;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("current_schema() AS schema")) return { rows: [{ schema: "app_schema" }] };
      if (options.failOnCreateIndex && /create index/i.test(text)) {
        throw new Error('column "missing_column" does not exist');
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    options: {},
    connect: () => Promise.resolve(client),
    end: async () => {},
  } as unknown as Pool;
  return { pool, queries };
}

describe("initializePostgresDatabaseVerifyOnly（服务启动专用：严格只读 verify，绝不 bootstrap、失败释放 Pool）", () => {
  it("空 schema fail-fast（无 ledger、无 managed 表），且不发出任何 CREATE TABLE/INDEX DDL，失败路径 pool.end 恰一次", async () => {
    const queries: string[] = [];
    const client = {
      async query(text: string) {
        queries.push(text);
        if (/current_schema\(\) AS schema/i.test(text)) return { rows: [{ schema: "app_schema" }] };
        if (/information_schema\.tables/i.test(text)) return { rows: [] };
        return { rows: [] };
      },
      release() {},
    };
    const end = vi.fn(() => Promise.resolve());
    const pool = {
      options: {},
      connect: () => Promise.resolve(client),
      end,
    } as unknown as Pool;

    await expect(initializePostgresDatabaseVerifyOnly(pool)).rejects.toThrow(/database has not been initialized/);

    // verify-only 绝不 bootstrap：没有任何建表/建索引 DDL
    expect(queries.some((q) => /create\s+table/i.test(q))).toBe(false);
    expect(queries.some((q) => /create\s+index/i.test(q))).toBe(false);
    // 失败路径 destroy → pool.end 恰一次
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("PG 原子 bootstrap：advisory lock + 事务回滚 + 重试", () => {
  it("中途 DDL 失败 → 事务回滚（无 COMMIT）、先取 advisory lock（按当前库键控）才 preflight", async () => {
    const recording = recordingPool({ failOnCreateIndex: true });
    await expect(initializePostgresDatabase(recording.pool, { manifest: brokenBootstrapManifest() }))
      .rejects.toThrow(/missing_column/);

    // 事务内先 begin、再 advisory lock、再 catalog preflight：
    const beginIndex = recording.queries.findIndex((q) => q.startsWith("begin"));
    const lockIndex = recording.queries.findIndex((q) => q.includes("pg_advisory_xact_lock"));
    const catalogIndex = recording.queries.findIndex((q) => q.includes("information_schema.tables"));
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(lockIndex);
    expect(lockIndex).toBeLessThan(catalogIndex);
    // 锁 scope 按当前数据库名键控（不跨库互锁）：
    expect(recording.queries[lockIndex]).toMatch(/current_database\(\)/);
    // 失败事务：回滚且绝不 COMMIT：
    expect(recording.queries).toContain("rollback");
    expect(recording.queries).not.toContain("commit");
  });

  it("回滚后可用生产 Manifest 重试成功（COMMIT、无 ROLLBACK）", async () => {
    const retry = recordingPool();
    const kysely = await initializePostgresDatabase(retry.pool);
    expect(retry.queries).toContain("commit");
    expect(retry.queries).not.toContain("rollback");
    // 完整 DDL 跑过（含生产 schema 的显式索引）：
    expect(retry.queries.some((q) => /create index/i.test(q) && q.includes("idx_projects_owner"))).toBe(true);
    await kysely.destroy();
  });
});