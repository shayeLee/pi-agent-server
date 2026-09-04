// WP4B（方案 A）real PostgreSQL planner gate：只读计划、零写入、无路径泄漏。
// 无 URL 时本文件按既有门控 skip（普通 `pnpm test`），强制门禁 `pnpm test:file-ops-pg`
// 缺 URL fail-closed（scripts/test-file-ops-pg.ts）；本文件绝不回退 SQLite。
// planner 只读性质同时由：
// - in-process 层强制（readOnlyPostgresUrl：严格解析仅 search_path options，合并
//   default_transaction_read_only=on 与 lock_timeout），且随机 schema 的
//   search_path 与只读约束同时生效（SHOW 断言）；
// - 真实 CLI PG 分支（source 入口 scripts/file-ops.ts，经 tsx 运行）：门禁真实跑 CLI，
//   验证随机 schema 隔离、只读、零 DB 变化、无 URL/path/credential 泄漏。
//   主题隔离通过 URL 的 search_path options 绑定随机专属 schema——**绝不创建任何
//   LOGIN role / 不使用 CREATEROLE**，绝不触碰任何真实用户 schema 或角色。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { resolveBinPath } from "../../scripts/test-postgres.js";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { enforceReadOnlyPostgresUrl, requirePostgresConnectionUrl } from "../../src/storage/postgres-connection.js";
import { KyselyFileOperationRepository } from "../../src/storage/kysely-file-operation-repository.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { planFileOperationBatch } from "../../src/file-operations/planner.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import type { Kysely } from "kysely";

const pgUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/file-operation-planner", pgUrl, false);
const describePg = pgUrl ? describe : describe.skip;

if (pgUrl !== undefined) {
  // 严格校验门禁环境 URL：协议/host/database 显式、禁止 fragment；不合法 → 立即失败。
  requirePostgresConnectionUrl(pgUrl);
}

const plannerCliEntry = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "scripts", "file-ops.ts",
);

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaName(): string {
  return `pi_file_ops_plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9_]/g, "_");
}
function scopedUrl(schema: string): string {
  const url = new URL(pgUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

const cleanups: string[] = [];
const ADMIN_TIMEOUTS = {
  connectionTimeoutMillis: 10_000,
  queryTimeoutMs: 15_000,
  statementTimeoutMs: 15_000,
} as const;
const ADMIN_PG_CONFIG = {
  connectionTimeoutMillis: ADMIN_TIMEOUTS.connectionTimeoutMillis,
  query_timeout: ADMIN_TIMEOUTS.queryTimeoutMs,
  statement_timeout: ADMIN_TIMEOUTS.statementTimeoutMs,
} as const;

describePg("WP4B file_operations planner（real PostgreSQL）", () => {
  let schema: string;
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let kysely: Kysely<DatabaseSchema> | undefined;
  let operations: KyselyFileOperationRepository;

  beforeAll(async () => {
    schema = schemaName();
    admin = new Pool({ connectionString: pgUrl!, ...ADMIN_PG_CONFIG });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    pool = createPostgresPool(scopedUrl(schema), ADMIN_TIMEOUTS);
    kysely = createPostgresKysely(pool!);
    await runPostgresMigrations(kysely!);
    operations = new KyselyFileOperationRepository(kysely!, "postgres");
  });

  beforeEach(async () => {
    await pool!.query("TRUNCATE TABLE file_operations");
  });

  afterEach(async () => {
    await pool!.query("TRUNCATE TABLE file_operations");
    for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  afterAll(async () => {
    // finally 语义：无论前序用例是否失败，schema 必须可靠回收；不创建任何 role。
    try {
      // Kysely owns the application pool once it has been created. Do not call
      // pool.end() after kysely.destroy(): that is a duplicate close.
      if (kysely !== undefined) {
        await kysely.destroy();
        kysely = undefined;
        pool = undefined;
      } else if (pool !== undefined) {
        // before Kysely is created, the fixture still owns the pool directly.
        await pool.end();
        pool = undefined;
      }
    } finally {
      if (admin !== undefined) {
        try {
          if (schema !== undefined) await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
        } finally {
          await admin.end();
          admin = undefined;
        }
      }
    }
  });

  it("dry-run 零写：planner 不 claim/complete/fail，行状态与 lease 字段原样", async () => {
    const queued = await operations.enqueue({ operationKey: "pg-plan-1", relativePath: "sessions/s1/history.jsonl", createdAt: 1 });
    await operations.enqueue({ operationKey: "pg-plan-2", relativePath: "sessions/s2/history.jsonl", createdAt: 2 });
    const now = Date.now();
    const report = await planFileOperationBatch(operations, now);
    expect(report.executable).toBe(false);
    expect(report.mode).toBe("dry-run");
    expect(report.planned).toBe(2);
    expect(report.pending).toBe(2);
    expect(report.processingExpired).toBe(0);
    expect(report.failedDue).toBe(0);
    expect(report.stateCounts).toEqual({ pending: 2, processing: 0, completed: 0, failed: 0 });
    expect(report.errorCodes).toEqual({});
    const rows = await operations.list();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === "pending" && row.attemptCount === 0 && row.leaseToken === null && row.leaseUntil === null)).toBe(true);
    expect((await operations.get(queued.id))?.state).toBe("pending");
  });

  it("报告与 JSON 不含任何相对/绝对路径", async () => {
    const cwd = "/var/lib/pi-agent-server-data";
    await operations.enqueue({ operationKey: "pg-plan-leak", relativePath: "projects/p-secret/sessions/s3/history.jsonl", createdAt: 1 });
    const report = await planFileOperationBatch(operations, Date.now());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("projects");
    expect(serialized).not.toContain("sessions");
    expect(serialized).not.toContain("history.jsonl");
    expect(serialized).not.toContain("p-secret");
    expect(serialized).not.toContain("/");
    expect(serialized).not.toContain(cwd);
  });

  it("planner 在只读事务约束（default_transaction_read_only）下仍可计划", async () => {
    // 模拟 CLI 的只读连接约束：生产代码（enforceReadOnlyPostgresUrl）严格解析仅
    // search_path options 并合并 default_transaction_read_only=on 与 lock_timeout。
    const readOnlyUrl = enforceReadOnlyPostgresUrl(scopedUrl(schema), { lockTimeoutMs: 10_000 });
    const readOnlyPool = createPostgresPool(readOnlyUrl, ADMIN_TIMEOUTS);
    let readOnlyKysely: Kysely<DatabaseSchema> | undefined;
    try {
      // Pool options prove all client/server-side bounds are wired; SHOW proves
      // the server-side statement/lock bounds and read-only search path.
      expect(readOnlyPool.options.connectionTimeoutMillis).toBe(ADMIN_TIMEOUTS.connectionTimeoutMillis);
      expect(readOnlyPool.options.query_timeout).toBe(ADMIN_TIMEOUTS.queryTimeoutMs);
      expect(readOnlyPool.options.statement_timeout).toBe(ADMIN_TIMEOUTS.statementTimeoutMs);
      // 直接证明连接同时具备这些约束：随机 schema 可见 + 服务端只读 + 有界 lock。
      const searchPath = await readOnlyPool.query("SHOW search_path");
      expect(searchPath.rows[0]?.search_path).toContain(schema);
      const readOnly = await readOnlyPool.query("SHOW transaction_read_only");
      expect(readOnly.rows[0]?.transaction_read_only).toBe("on");
      const lockTimeout = await readOnlyPool.query("SHOW lock_timeout");
      expect(String(lockTimeout.rows[0]?.lock_timeout)).toBe("10s");
      const statementTimeout = await readOnlyPool.query("SHOW statement_timeout");
      expect(String(statementTimeout.rows[0]?.statement_timeout)).toBe("15s");
      readOnlyKysely = createPostgresKysely(readOnlyPool);
      await runPostgresMigrations(readOnlyKysely, { mode: "verify" });
      const readOnlyOperations = new KyselyFileOperationRepository(readOnlyKysely, "postgres");
      await operations.enqueue({ operationKey: "pg-plan-ro", relativePath: "sessions/ro/history.jsonl", createdAt: 1 });
      const report = await planFileOperationBatch(readOnlyOperations, Date.now());
      expect(report.planned).toBe(1);
      expect(report.pending).toBe(1);
      // 读后行未被触碰。
      expect((await readOnlyOperations.list("pending"))).toHaveLength(1);
      // 写尝试必须被服务端拒绝（fail-closed 证明连接确实是只读的）。
      await expect(readOnlyOperations.claim(Date.now(), 1, 60_000)).rejects.toThrow(/read-only|read only|transaction/i);
    } finally {
      if (readOnlyKysely !== undefined) await readOnlyKysely.destroy();
      else await readOnlyPool.end();
    }
  });

  it("真实 CLI PG 分支（source 入口）使用随机 schema URL（search_path options）只读计划，零 DB 变化、无泄漏", async () => {
    // 主题隔离：URL 直接携带随机 schema 的 search_path options；CLI 严格解析
    // options（仅 search_path）并合并 default_transaction_read_only=on 与
    // lock_timeout——**不创建任何 LOGIN role / 不使用 CREATEROLE**。
    const cliUrl = scopedUrl(schema);
    await operations.enqueue({ operationKey: "pg-cli-1", relativePath: "sessions/s1/history.jsonl", createdAt: 1 });
    await operations.enqueue({ operationKey: "pg-cli-2", relativePath: "sessions/s2/history.jsonl", createdAt: 2 });

    const result = spawnSync(
      process.execPath,
      [resolveBinPath("tsx", "tsx"), plannerCliEntry, "run"],
      {
        env: { ...process.env, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: cliUrl },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    // 失败时附上 CLI 输出便于未来诊断（不吞 stderr/status）。
    expect(result.status, `file-ops CLI 退出码 ${String(result.status)} 非 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr ?? ""}`).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(report.status).toBe("planned");
    expect(report.dialect).toBe("PostgreSQL");
    expect(report.mode).toBe("dry-run");
    expect(report.executable).toBe(false);
    expect(report.planned).toBe(2);
    expect(report.pending).toBe(2);
    expect(result.stderr ?? "").toContain("只读 planner");

    // 无 URL / path / credential / schema 泄漏。
    const allOutput = `${result.stdout}\n${result.stderr ?? ""}`;
    expect(allOutput).not.toContain("postgresql://");
    expect(allOutput).not.toContain(schema);
    expect(allOutput).not.toContain("search_path");
    expect(allOutput).not.toContain("sessions/");
    expect(allOutput).not.toContain("history.jsonl");

    // 零 DB 变化：行状态、lease、attempt 原样。
    const rows = await operations.list();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === "pending" && row.attemptCount === 0 && row.leaseToken === null && row.leaseUntil === null)).toBe(true);

    // 只读证明：CLI 同款 schema URL（生产枚举整个 enforceReadOnlyPostgresUrl）上
    // 服务端只读 + 写操作被拒绝。
    const readOnlyUrl = enforceReadOnlyPostgresUrl(cliUrl, { lockTimeoutMs: 10_000 });
    const readOnlyPool = createPostgresPool(readOnlyUrl, ADMIN_TIMEOUTS);
    try {
      expect(readOnlyPool.options.connectionTimeoutMillis).toBe(ADMIN_TIMEOUTS.connectionTimeoutMillis);
      expect(readOnlyPool.options.query_timeout).toBe(ADMIN_TIMEOUTS.queryTimeoutMs);
      expect(readOnlyPool.options.statement_timeout).toBe(ADMIN_TIMEOUTS.statementTimeoutMs);
      const searchPath = await readOnlyPool.query("SHOW search_path");
      expect(searchPath.rows[0]?.search_path).toContain(schema);
      const readOnly = await readOnlyPool.query("SHOW transaction_read_only");
      expect(readOnly.rows[0]?.transaction_read_only).toBe("on");
      const statementTimeout = await readOnlyPool.query("SHOW statement_timeout");
      expect(String(statementTimeout.rows[0]?.statement_timeout)).toBe("15s");
      const lockTimeout = await readOnlyPool.query("SHOW lock_timeout");
      expect(String(lockTimeout.rows[0]?.lock_timeout)).toBe("10s");
      const count = await readOnlyPool.query("SELECT count(*) AS n FROM file_operations");
      expect(Number(count.rows[0]?.n)).toBe(2);
      await expect(readOnlyPool.query(
        "INSERT INTO file_operations (id, operation_key, kind, relative_path, state, attempt_count, available_at, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000000', 'cli-write', 'delete', 'sessions/w/history.jsonl', 'pending', 0, 1, 1, 1)",
      )).rejects.toThrow(/read-only|read only|transaction/i);
    } finally {
      await readOnlyPool.end();
    }
  });
});