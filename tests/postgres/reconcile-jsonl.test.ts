// WP4C（方案 A 收敛）real PostgreSQL reconcile analyzer gate：只读 DB 分析、
// 零写入、无路径/URL 泄漏。无 URL 时本文件按既有门控 skip（普通 `pnpm test`），
// 强制门禁 `pnpm test:reconcile-jsonl-pg` 缺 URL fail-closed
// （scripts/test-reconcile-jsonl-pg.ts）；本文件绝不回退 SQLite。
// 覆盖：
// - **绝不创建任何 LOGIN role / 使用 CREATEROLE**：随机专属 schema 通过 URL 的
//   search_path options 绑定（CLI 严格解析 options——仅 search_path——并合并
//   default_transaction_read_only=on 与 lock_timeout）；
// - face 用 runPostgresMigrations apply（**含 ledger**）建随机专属 schema；种子
//   数据一律 $1 参数绑定，绝不用 ident() 拼值；不在文件系统创建/写入任何文件——
//   DATA_DIR 只是参与词法绑定的字符串；
// - 受控只读引用（session id/project id/conversation_ref）在真实 PG 上取数；
// - 连接串严格校验（协议/host/database 显式、禁止 fragment）；CLI/库层有界超时
//   （connect/query/statement/lock）；readOnly URL 保留随机 schema search_path
//   并强制只读（SHOW 双断言），迁移 verify 只读可用，写操作被服务端拒绝；
// - 真实 CLI PG 分支（source 入口 scripts/reconcile-jsonl.ts，经 tsx）直接使用
//   随机 schema URL（search_path options），随机 schema 隔离、只读、零 DB 变化、
//   无 URL/path/credential 泄漏、executable:false、filesystemNotScanned；
// - URL options 含 search_path 之外的内容时 CLI fail-closed（不发起连接、不出 JSON）；
// - 清理可靠：afterAll 在 finally 语义下 DROP SCHEMA CASCADE（role 已不存在——
//   本门禁不创建任何 role）。
// WP4C 方案 A 不存在执行器：本门禁从不演练删除/恢复（executable 恒为 false）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { resolveBinPath } from "../../scripts/test-postgres.js";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { enforceReadOnlyPostgresUrl, requirePostgresConnectionUrl } from "../../src/storage/postgres-connection.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { KyselyReconcileReferenceRepository } from "../../src/storage/kysely-reconcile-reference-repository.js";
import { analyzeReconcileReferences } from "../../src/file-operations/reconcile.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/reconcile-jsonl", pgUrl, false);
const describePg = pgUrl ? describe : describe.skip;

if (pgUrl !== undefined) {
  // 严格校验门禁环境 URL：协议/host/database 显式、禁止 fragment；不合法 → 立即失败。
  requirePostgresConnectionUrl(pgUrl);
}

const reconcileCliEntry = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "scripts", "reconcile-jsonl.ts",
);

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaName(): string {
  return `pi_reconcile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9_]/g, "_");
}
function scopedUrl(schema: string): string {
  const url = new URL(pgUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

// DATA_DIR 只是词法绑定字符串：不创建目录、不写任何文件（连接串/path 均不打印）。
const DATA_DIR = "/var/lib/pi-agent-server-reconcile-gate-data";

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

describePg("WP4C reconcile analyzer（real PostgreSQL）", () => {
  let schema: string;
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let kysely: Kysely<DatabaseSchema> | undefined;

  beforeAll(async () => {
    schema = schemaName();
    admin = new Pool({ connectionString: pgUrl!, ...ADMIN_PG_CONFIG });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    pool = createPostgresPool(scopedUrl(schema), ADMIN_TIMEOUTS);
    kysely = createPostgresKysely(pool!);
    // 正式迁移引擎 apply：创建并写入 migration ledger（与 CLI verify 同源）。
    await runPostgresMigrations(kysely!);
    // 种子数据：project id 用参数绑定，绝不用 ident() 拼值。
    await pool!.query(
      "INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)",
      [DEFAULT_PROJECT_ID, "默认项目", "/tmp", "", 0],
    );
  });

  beforeEach(async () => {
    await pool!.query("DELETE FROM sessions");
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

  async function seedSessions(rows: Array<{ sessionId: string; projectId?: string; conversationRef: string | null }>): Promise<void> {
    for (const row of rows) {
      await pool!.query(
        `INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, model_provider, model_id, thinking_level, system_prompt, capability_versions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL, NULL)`,
        [row.sessionId, "owner", row.projectId ?? DEFAULT_PROJECT_ID, "title", 1, 1, row.conversationRef],
      );
    }
  }

  it("只读连接（search_path + read_only + lock_timeout 三约束）下分析：分类正确、零 DB 变化、写被服务端拒绝", async () => {
    const s1 = randomUUID();
    const validFile = path.join(DATA_DIR, "sessions", s1, "2025-01-01T00-00-00_x.jsonl");
    const s2 = randomUUID();
    const s3 = randomUUID();
    const s4 = randomUUID();
    // 非空 conversation identity 唯一约束禁止共享同一引用：s4 使用自己独占的合法引用。
    const s4File = path.join(DATA_DIR, "sessions", s4, "2025-01-01T00-00-00_x.jsonl");
    await seedSessions([
      { sessionId: s1, conversationRef: validFile }, // valid（文件无需存在：不扫描）
      { sessionId: s2, conversationRef: null }, // unmaterialized（normal）
      { sessionId: s3, conversationRef: path.join(DATA_DIR, "..", "escape.jsonl") }, // traversal → invalid
      { sessionId: s4, conversationRef: s4File }, // valid（独占引用，唯一约束禁止共享）
    ]);

    // 经生产代码（enforceReadOnlyPostgresUrl）构造只读 URL：严格解析仅 search_path
    // 并合并 default_transaction_read_only=on 与 lock_timeout。
    const readOnlyUrl = enforceReadOnlyPostgresUrl(scopedUrl(schema), { lockTimeoutMs: 10_000 });
    const readOnlyPool = createPostgresPool(readOnlyUrl, ADMIN_TIMEOUTS);
    let readOnlyKysely: Kysely<DatabaseSchema> | undefined;
    try {
      // Pool options prove all client/server-side bounds are wired; SHOW proves
      // the server-side statement/lock bounds and read-only search path.
      expect(readOnlyPool.options.connectionTimeoutMillis).toBe(ADMIN_TIMEOUTS.connectionTimeoutMillis);
      expect(readOnlyPool.options.query_timeout).toBe(ADMIN_TIMEOUTS.queryTimeoutMs);
      expect(readOnlyPool.options.statement_timeout).toBe(ADMIN_TIMEOUTS.statementTimeoutMs);
      // 三断言：随机 schema 可见 + 服务端只读 + 有界 lock 等待。
      const searchPath = await readOnlyPool.query("SHOW search_path");
      expect(searchPath.rows[0]?.search_path).toContain(schema);
      const readOnly = await readOnlyPool.query("SHOW transaction_read_only");
      expect(readOnly.rows[0]?.transaction_read_only).toBe("on");
      const lockTimeout = await readOnlyPool.query("SHOW lock_timeout");
      expect(String(lockTimeout.rows[0]?.lock_timeout)).toBe("10s");
      const statementTimeout = await readOnlyPool.query("SHOW statement_timeout");
      expect(String(statementTimeout.rows[0]?.statement_timeout)).toBe("15s");

      readOnlyKysely = createPostgresKysely(readOnlyPool);
      // 迁移 head verify 在只读会话下可用且不写。
      await runPostgresMigrations(readOnlyKysely, { mode: "verify" });
      const rows = await new KyselyReconcileReferenceRepository(readOnlyKysely).listReconcileReferences();
      expect(rows).toHaveLength(4);
      const report = await analyzeReconcileReferences(DATA_DIR, rows);
      expect(report.status).toBe("analyzed");
      expect(report.executable).toBe(false);
      expect(report.mode).toBe("dry-run");
      expect(report.filesystemNotScanned).toBe(true);
      expect(report.cannotDetect).toEqual({ orphanFile: false, lostFile: false, jsonlValidity: false });
      expect(report.references).toBe(4);
      expect(report.unmaterialized).toBe(1);
      expect(report.valid).toBe(2); // s1 + s4（各自独占引用）
      expect(report.invalidReferences).toBe(1);
      expect(report.duplicateReferences).toBe(0); // 唯一约束使共享非空引用不可能
      // 报告无路径/URL/schema/session id 泄漏。
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("sessions");
      expect(serialized).not.toContain(DATA_DIR);
      expect(serialized).not.toContain(s1);
      expect(serialized).not.toContain("postgres://");
      expect(serialized.match(/\//g)).toBeNull();

      // 零 DB 变化。
      const count = await readOnlyPool.query("SELECT count(*) AS n FROM sessions");
      expect(Number(count.rows[0]?.n)).toBe(4);
      const unchanged = await readOnlyPool.query("SELECT id, conversation_ref FROM sessions ORDER BY id");
      expect(unchanged.rows).toHaveLength(4);

      // 写尝试必须被服务端拒绝（fail-closed 证明连接确实是只读的）。
      await expect(readOnlyPool.query(
        "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
        ["00000000-0000-4000-8000-000000000000", "w", DEFAULT_PROJECT_ID, "t", 1, 1],
      )).rejects.toThrow(/read-only|read only|transaction/i);
    } finally {
      if (readOnlyKysely !== undefined) await readOnlyKysely.destroy();
      else await readOnlyPool.end();
    }
  });

  it("真实 CLI PG 分支（source 入口）直接使用随机 schema URL（search_path options）只读分析，零 DB 变化、无泄漏", async () => {
    const s1 = randomUUID();
    const s2 = randomUUID();
    await seedSessions([
      { sessionId: s1, conversationRef: path.join(DATA_DIR, "sessions", s1, "2025-01-01T00-00-00_s1.jsonl") },
      { sessionId: s2, conversationRef: null },
    ]);
    // 主题隔离：URL 直接携带随机 schema 的 search_path options；CLI 严格解析
    // options（仅 search_path）并合并 default_transaction_read_only=on 与
    // lock_timeout——**不创建任何 LOGIN role / 不使用 CREATEROLE**。
    const cliUrl = scopedUrl(schema);

    const result = spawnSync(
      process.execPath,
      [resolveBinPath("tsx", "tsx"), reconcileCliEntry, "run"],
      {
        env: {
          ...process.env,
          PI_STORAGE_DIALECT: "postgres",
          PI_DATABASE_URL: cliUrl,
          DATA_DIR,
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(result.status, `reconcile CLI 退出码 ${String(result.status)} 非 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr ?? ""}`).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(report.status).toBe("analyzed");
    expect(report.dialect).toBe("PostgreSQL");
    expect(report.mode).toBe("dry-run");
    expect(report.executable).toBe(false);
    expect(report.filesystemNotScanned).toBe(true);
    expect(report.references).toBe(2);
    expect(report.unmaterialized).toBe(1);
    expect(report.valid).toBe(1);
    expect(result.stderr ?? "").toContain("只读 DB reference 分析");

    // 无 URL / path / credential / schema / session id 泄漏。
    const allOutput = `${result.stdout}\n${result.stderr ?? ""}`;
    expect(allOutput).not.toContain("postgresql://");
    expect(allOutput).not.toContain(schema);
    expect(allOutput).not.toContain("search_path");
    expect(allOutput).not.toContain("sessions/");
    expect(allOutput).not.toContain(DATA_DIR);
    expect(allOutput).not.toContain(s1);

    // 服务端断言（CLI 同款 schema + 只读约束）：随机 schema 可见、只读、零变化、
    // 写被拒绝。
    const readOnlyUrl = enforceReadOnlyPostgresUrl(cliUrl, { lockTimeoutMs: 10_000 });
    const readOnlyPool = createPostgresPool(readOnlyUrl, ADMIN_TIMEOUTS);
    let readOnlyKysely: Kysely<DatabaseSchema> | undefined;
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
      const count = await readOnlyPool.query("SELECT count(*) AS n FROM sessions");
      expect(Number(count.rows[0]?.n)).toBe(2);
      await expect(readOnlyPool.query(
        "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
        ["00000000-0000-4000-8000-000000000001", "w", DEFAULT_PROJECT_ID, "t", 1, 1],
      )).rejects.toThrow(/read-only|read only|transaction/i);
    } finally {
      if (readOnlyKysely !== undefined) await readOnlyKysely.destroy();
      else await readOnlyPool.end();
    }
  });

  it("URL options 含 search_path 之外的内容：真实 CLI fail-closed（不发起业务查询、无输出 JSON、不回显 URL）", async () => {
    const cliUrl = new URL(pgUrl!);
    cliUrl.searchParams.set("options", "-c statement_timeout=1000");
    const result = spawnSync(
      process.execPath,
      [resolveBinPath("tsx", "tsx"), reconcileCliEntry, "run"],
      {
        env: {
          ...process.env,
          PI_STORAGE_DIALECT: "postgres",
          PI_DATABASE_URL: cliUrl.toString(),
          DATA_DIR,
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
    const allOutput = `${result.stdout}\n${result.stderr ?? ""}`;
    expect(allOutput).toContain("RECONCILE_FAILED");
    expect(allOutput).not.toContain("postgresql://");
    expect(allOutput).not.toContain("statement_timeout");
    expect(allOutput).not.toContain("options");
  });
});