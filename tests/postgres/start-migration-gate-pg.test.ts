// WP2A 真实 PostgreSQL 启动 migration 门禁（migrationGate="verify"）：
// - 空 schema：fail-fast 明确提示离线 cutover/migrate，且门禁绝不写入（schema 内零表）、
//   门禁 Pool/Kysely 在失败路径销毁（不留残余连接）；
// - 已 apply 到 head 的 schema：门禁通过后用全新的 actual Pool 完成 bootstrap 并正常服务
//   /health；关闭后无残余连接。
// 仅在 PI_TEST_PG_URL 可用且由强制 runner 运行时执行；普通 `pnpm test` 安全 skip。
// fixture 只创建/销毁自己的随机 pi_cutover_* schema；绝不 DROP DATABASE、绝不触碰 public。
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";

const baseUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/start-migration-gate-pg", baseUrl, false);
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

/** 除当前 admin 连接自身外，是否还有本角色的残余（泄漏）连接。 */
async function leakedConnections(): Promise<number> {
  const result = await admin!.query(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename = current_user AND datname = current_database()",
  );
  return result.rows[0]?.count ?? 0;
}

describeGate("startServer 严格 migration 门禁（真实 PostgreSQL：独立 gate Pool → 销毁 → fresh actual Pool）", () => {
  afterAll(async () => {
    for (const schema of cleanupSchemas) await admin?.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("gate=verify fails fast on an empty schema with the offline cutover/migrate instruction, writes nothing, and destroys the gate pool", async () => {
    const schema = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    cleanupSchemas.push(schema);
    admin = new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    const dir = mkdtempSync(join(tmpdir(), "pi-start-gate-pg-"));
    cleanups.push(dir);

    await expect(startServer(baseConfig(scopedUrl(baseUrl!, schema), dir)))
      .rejects.toThrow(/startup migration gate.*cutover.*migrate/s);

    // 门禁绝不写入：空 schema 在失败的门禁后仍然没有任何表（bootstrap 未发生）。
    const tables = await admin.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1", [schema]);
    expect(tables.rows[0]?.count).toBe(0);
    // 失败路径同样销毁 gate Pool/Kysely：不留残余连接。
    expect(await leakedConnections()).toBe(0);
  }, 120_000);

  it("gate=verify passes on a migrated schema and serves HTTP via a fresh actual pool, with no leaked connections after close", async () => {
    const schema = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    cleanupSchemas.push(schema);
    admin = admin ?? new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    const dir = mkdtempSync(join(tmpdir(), "pi-start-gate-pg-ok-"));
    cleanups.push(dir);

    // 先用一次性连接把 schema 迁移到 head（模拟离线 cutover/migrate 完成后的目标状态）。
    const seedPool = createPostgresPool(scopedUrl(baseUrl!, schema), { connectionTimeoutMillis: 5_000 });
    const seedKysely = createPostgresKysely(seedPool);
    try {
      const applied = await runPostgresMigrations(seedKysely, { mode: "apply" });
      expect(applied.status).toBe("applied");
    } finally {
      await seedKysely.destroy();
    }
    expect(await leakedConnections()).toBe(0);

    const app = await startServer(baseConfig(scopedUrl(baseUrl!, schema), dir));
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      // 启动后 ledger 仍在 head，且服务没有自动迁移/删除副作用。
      const ledger = await admin!.query(`SELECT version FROM ${ident(schema)}.schema_migrations ORDER BY version`);
      expect(ledger.rows.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
    // 实际 Pool 随 app.close 幂等销毁。
    expect(await leakedConnections()).toBe(0);
  }, 180_000);
});
