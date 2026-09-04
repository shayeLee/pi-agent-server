// WP4B（方案 A）real PostgreSQL planner gate：只读计划、零写入、无路径泄漏。
// 无 URL 时本文件按既有门控 skip（普通 `pnpm test`），强制门禁 `pnpm test:file-ops-pg`
// 缺 URL fail-closed（scripts/test-file-ops-pg.ts）；本文件绝不回退 SQLite。
// planner 只读性质同时由：
// - in-process 层强制（readOnlyPostgresUrl：default_transaction_read_only=on），
//   且 readOnly URL 同时保留随机 schema 的 search_path 与只读约束；
// - 真实 CLI PG 分支（source 入口 scripts/file-ops.ts，经 tsx 运行）：门禁真实跑 CLI，
//   验证随机 schema 隔离、只读、零 DB 变化、无 URL/path/credential 泄漏。
//   主题 role 由 fixture 创建/销毁，绝不触碰任何真实用户 schema 或角色。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { resolveBinPath } from "../../scripts/test-postgres.js";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { KyselyFileOperationRepository } from "../../src/storage/kysely-file-operation-repository.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { planFileOperationBatch } from "../../src/file-operations/planner.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import type { Kysely } from "kysely";

const pgUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/file-operation-planner", pgUrl, false);
const describePg = pgUrl ? describe : describe.skip;

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
const cleanupRoles: string[] = [];

describePg("WP4B file_operations planner（real PostgreSQL）", () => {
  let schema: string;
  let admin: Pool;
  let pool: Pool;
  let kysely: Kysely<DatabaseSchema>;
  let operations: KyselyFileOperationRepository;

  beforeAll(async () => {
    schema = schemaName();
    admin = new Pool({ connectionString: pgUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    pool = createPostgresPool(scopedUrl(schema));
    kysely = createPostgresKysely(pool);
    await runPostgresMigrations(kysely);
    operations = new KyselyFileOperationRepository(kysely, "postgres");
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE file_operations");
  });

  afterEach(async () => {
    await pool.query("TRUNCATE TABLE file_operations");
    for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pool.end();
    if (admin) {
      for (const role of cleanupRoles.splice(0)) {
        await admin.query(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => undefined);
      }
      await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
      await admin.end();
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
    // 模拟 CLI 的只读连接约束：readOnly URL 必须同时保留随机 schema 的
    // search_path 与 default_transaction_read_only=on（顺序无关，两个 -c 并存）。
    const readOnlyUrl = new URL(scopedUrl(schema));
    readOnlyUrl.searchParams.set("options", `-c search_path=${schema} -c default_transaction_read_only=on`);
    const readOnlyPool = createPostgresPool(readOnlyUrl.toString());
    try {
      // 直接证明连接同时具备两个约束：随机 schema 可见 + 服务端只读。
      const searchPath = await readOnlyPool.query("SHOW search_path");
      expect(searchPath.rows[0]?.search_path).toContain(schema);
      const readOnly = await readOnlyPool.query("SHOW transaction_read_only");
      expect(readOnly.rows[0]?.transaction_read_only).toBe("on");
      const readOnlyKysely = createPostgresKysely(readOnlyPool);
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
      await readOnlyPool.end();
    }
  });

  it("真实 CLI PG 分支（source 入口）在随机 schema 上只读计划，零 DB 变化、无泄漏", async () => {
    // 主题隔离：只读 planner 要求 URL 不含 options（CLI 强制追加
    // default_transaction_read_only=on 时对既有 options fail-closed），因此用
    // fixture 创建/销毁的随机 role 提供 schema 级 search_path 默认值；
    // role 通过 ALTER ROLE 绑定到随机 schema，绝不触碰 public 或真实用户对象。
    const role = `pi_fo_cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-zA-Z0-9_]/g, "_");
    const rolePassword = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.replace(/[^a-zA-Z0-9]/g, "a");
    cleanupRoles.push(role);
    await admin.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${rolePassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(role)}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${ident(role)}`);
    await admin.query(`ALTER ROLE ${ident(role)} SET search_path = ${ident(schema)}`);

    const cliUrl = new URL(pgUrl!);
    cliUrl.username = role;
    cliUrl.password = rolePassword;
    cliUrl.searchParams.delete("options"); // 必须无 options：CLI 对既有 options fail-closed。
    await operations.enqueue({ operationKey: "pg-cli-1", relativePath: "sessions/s1/history.jsonl", createdAt: 1 });
    await operations.enqueue({ operationKey: "pg-cli-2", relativePath: "sessions/s2/history.jsonl", createdAt: 2 });

    const result = spawnSync(
      process.execPath,
      [resolveBinPath("tsx", "tsx"), plannerCliEntry, "run"],
      {
        env: { ...process.env, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: cliUrl.toString() },
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
    expect(allOutput).not.toContain(rolePassword);
    expect(allOutput).not.toContain(schema);
    expect(allOutput).not.toContain("sessions/");
    expect(allOutput).not.toContain("history.jsonl");

    // 零 DB 变化：行状态、lease、attempt 原样。
    const rows = await operations.list();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === "pending" && row.attemptCount === 0 && row.leaseToken === null && row.leaseUntil === null)).toBe(true);

    // 只读证明：同一 role 的连接（CLI 同款只读 options）上写操作被服务端拒绝。
    const readOnlyUrl = new URL(cliUrl);
    readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
    const readOnlyPool = createPostgresPool(readOnlyUrl.toString());
    try {
      const searchPath = await readOnlyPool.query("SHOW search_path");
      expect(searchPath.rows[0]?.search_path).toContain(schema);
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