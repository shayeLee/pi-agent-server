// WP5A 真实 PostgreSQL 接线：startServer(gate=verify) 在已迁移 schema 上 readyz=migration-head、
// /metrics storage dialect label=postgres 且 gate enabled/verified=1；空 schema 门禁失败 → 拒绝启动。
// 仅在 PI_TEST_PG_URL 可用且由强制 runner 运行时执行；普通 `pnpm test` 安全 skip（如实不宣称通过）。
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";

const baseUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/start-ops-pg", baseUrl, false);
const describeGate = Boolean(baseUrl) ? describe : describe.skip;
const cleanupSchemas: string[] = [];
const cleanups: string[] = [];
let admin: Pool | undefined;

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedUrl(url: string, targetSchema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${targetSchema} -c statement_timeout=20000`);
  return parsed.toString();
}

function baseConfig(databaseUrl: string, dir: string): StartConfig {
  return {
    port: 0,
    intranetCidrs: [],
    tokens: {},
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    cwd: dir,
    storageDialect: "postgres",
    databaseUrl,
    migrationGate: "verify",
  };
}

describeGate("startServer WP5A 接线（真实 PostgreSQL）", () => {
  afterAll(async () => {
    for (const schema of cleanupSchemas) await admin?.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("gate=verify 空 schema：拒绝启动（ready false 语义：无任何端点声称 ready）", async () => {
    const schema = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    cleanupSchemas.push(schema);
    admin = new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    const dir = mkdtempSync(join(tmpdir(), "pi-start-ops-pg-bad-"));
    cleanups.push(dir);
    await expect(startServer(baseConfig(scopedUrl(baseUrl!, schema), dir)))
      .rejects.toThrow(/startup migration gate.*cutover.*migrate/s);
  }, 120_000);

  it("gate=verify 已迁移 schema：readyz=migration-head，metrics dialect=postgres、gate 1/1", async () => {
    const schema = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    cleanupSchemas.push(schema);
    admin = admin ?? new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    const dir = mkdtempSync(join(tmpdir(), "pi-start-ops-pg-ok-"));
    cleanups.push(dir);

    const seedPool = createPostgresPool(scopedUrl(baseUrl!, schema), { connectionTimeoutMillis: 5_000 });
    const seedKysely = createPostgresKysely(seedPool);
    try {
      const applied = await runPostgresMigrations(seedKysely, { mode: "apply" });
      expect(applied.status).toBe("applied");
    } finally {
      await seedKysely.destroy();
    }

    const app = await startServer(baseConfig(scopedUrl(baseUrl!, schema), dir));
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });

      const readyz = await app.inject({ method: "GET", url: "/readyz" });
      expect(readyz.statusCode).toBe(200);
      expect(readyz.headers["cache-control"]).toBe("no-store");
      expect(readyz.json()).toEqual({
        ready: true,
        migrationGate: "verify",
        schema: "migration-head",
      });
      expect(readyz.body).not.toMatch(/postgresql:\/\/|url|path|auth|token/i);

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.headers["content-type"]).toMatch(/^text\/plain; version=0\.0\.4/);
      expect(metrics.headers["cache-control"]).toBe("no-store");
      expect(metrics.body).toContain("pi_agent_server_ready 1");
      expect(metrics.body).toContain("pi_agent_server_migration_gate_enabled 1");
      expect(metrics.body).toContain("pi_agent_server_migration_gate_verified 1");
      expect(metrics.body).toContain('pi_agent_server_storage_dialect_info{dialect="postgres"} 1');
      // 表层绝不泄漏连接串。
      expect(metrics.body).not.toMatch(/postgresql:\/\/|host|port|user=/i);
    } finally {
      await app.close();
    }
  }, 180_000);
});