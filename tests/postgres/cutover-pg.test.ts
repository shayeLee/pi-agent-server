// WP2A 真实 PostgreSQL cutover 门禁（随机 pi_cutover_* schema，隔离 database/schema）：
// 仅在 PI_TEST_PG_URL + pg_dump/pg_restore/age/age-keygen 可用且由强制 runner
// （scripts/test-cutover-pg.ts，设置 PI_TEST_PG_REQUIRED=1）运行；普通 `pnpm test` 安全 skip。
// fixture 负责创建并最终销毁随机 schema；绝不 DROP DATABASE、绝不触碰 public 数据。
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { createPostgresBackup, verifyPublishedBackup } from "../../src/backup/backup-core.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import {
  authorizeCutover,
  openPostgresDedicatedResetGate,
  parseCutoverArgs,
  resolvePostgresCutoverTarget,
  runControlledCutover,
  validateCutoverTargetSchema,
} from "../../src/cutover/cutover-core.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { checkPgBackupBinaries } from "../../scripts/test-pg-backup.js";

const baseUrl = process.env.PI_TEST_PG_URL?.trim();
const binaryGate = checkPgBackupBinaries();
assertRequiredPgTestEnvironment("tests/postgres/cutover-pg", baseUrl, true);
const describeGate = Boolean(baseUrl) && binaryGate.ok ? describe : describe.skip;
const cleanup: string[] = [];
let admin: Pool | undefined;
let schema: string | undefined;

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedUrl(url: string, targetSchema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${targetSchema} -c statement_timeout=20000`);
  return parsed.toString();
}

describeGate("WP2A real PostgreSQL controlled cutover gate", () => {
  afterAll(async () => {
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
    for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("performs schema-scoped reset + JSONL cleanup + migration apply inside a random pi_cutover_* schema, preserving models.json/credentials and leaving other schemas untouched", async () => {
    schema = validateCutoverTargetSchema(`pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    const bystander = `pi_cutover_bystander_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    admin = new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    await admin.query(`CREATE SCHEMA ${ident(bystander)}`);
    await admin.query(`CREATE TABLE ${ident(schema)}.${ident("legacy_rc_table")} (id int primary key, note text)`);
    await admin.query(`INSERT INTO ${ident(schema)}.${ident("legacy_rc_table")} VALUES (1, 'legacy data without ledger')`);
    const scoped = scopedUrl(baseUrl!, schema);

    const root = mkdtempSync(path.join(tmpdir(), "pi-cutover-pg-"));
    cleanup.push(root);
    const cwd = path.join(root, "app-cwd");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(dataDir, ".pi-agent");
    const backupRoot = path.join(root, "backups");
    const recipient = path.join(root, "recipient");
    const identity = path.join(root, "identity");
    // 与生产一致的 JSONL 布局 + 白名单服务配置 + dataDir 之外的真实凭证位置。
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "projects", "p1", "sessions", "s2"), { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
    const projectSessionFile = path.join(dataDir, "projects", "p1", "sessions", "s2", "history.jsonl");
    writeFileSync(sessionFile, '{"type":"session","id":"gate"}\n', { mode: 0o600 });
    writeFileSync(projectSessionFile, '{"type":"session","id":"gate-p"}\n', { mode: 0o600 });
    writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
    const credential = path.join(root, "creds", "service.auth");
    mkdirSync(path.dirname(credential), { recursive: true, mode: 0o700 });
    writeFileSync(credential, '{"token":"never-touch"}\n', { mode: 0o600 });
    writeFileSync(path.join(cwd, "unrelated.txt"), "cwd survives\n", { mode: 0o600 });
    const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
    expect(generated.status).toBe(0);
    const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
    expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
    writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });
    chmodSync(recipient, 0o600);

    const cli = parseCutoverArgs([
      "--apply", "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA",
      "--maintenance-window", "CONFIRMED",
      "--backup-root", backupRoot, "--age-recipient-file", recipient,
      "--target-schema", schema,
    ]);
    const environment = { AGENT_CWD: cwd, DATA_DIR: dataDir, PI_AGENT_DIR: agentDir, PI_AUTH_PATH: credential };
    const target = resolvePostgresCutoverTarget(environment as unknown as Record<string, string>, cli);
    const pool = createPostgresPool(scoped, { connectionTimeoutMillis: 5_000 });
    const kysely = createPostgresKysely(pool);
    // P0：reset 专用同连接门禁。recording pool 记录每个查询所在的真实后端 PID，
    // 验证 identity 复验与 DROP/CREATE/GRANT 发生在同一个专用连接/事务内。
    const gateQueries: string[] = [];
    const gatePids = new Map<string, string>();
    let gateConnects = 0;
    const gateRecordingPool = {
      connect: async () => {
        gateConnects++;
        const real = await pool.connect();
        return {
          query: async (text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> => {
            if (/current_database\(\)|DROP SCHEMA|COMMIT/.test(text)) {
              const pid = await real.query("SELECT pg_backend_pid() AS pid");
              gatePids.set(text, String((pid.rows[0] as { pid: unknown } | undefined)?.pid));
            }
            const result = await real.query(text, values as unknown[] | undefined);
            gateQueries.push(text);
            return result as unknown as { rows: Array<Record<string, unknown>> };
          },
          release: () => real.release(),
        };
      },
    };
    const resetGate = openPostgresDedicatedResetGate(gateRecordingPool, schema, target);
    try {
      const identityRows = await pool.query<{ schema: string | null }>("SELECT current_schema() AS schema");
      expect(identityRows.rows[0]?.schema).toBe(schema);
      const report = await runControlledCutover(authorizeCutover(cli), {
        createBackup: () => createPostgresBackup({
          storageDialect: "postgres", databaseUrl: scoped,
          paths: { dataDir, agentDir, authPath: target.authPath, backupRoot, ageRecipientFile: recipient },
          backupKind: "pre-reset",
        }),
        verifyBackup: verifyPublishedBackup,
        // 备份验证 + binding 复验（同一专用 PoolClient/事务内）之后才允许 reset；
        // DROP/CREATE/GRANT 也在同一 client/transaction 内执行，COMMIT 成功才生效。
        revalidateBeforeReset: (verification) => resetGate.revalidate(verification),
        reset: () => resetGate.reset(),
        applyMigration: () => runPostgresMigrations(kysely, { mode: "apply" }),
        verifyMigration: () => runPostgresMigrations(kysely, { mode: "verify" }),
      }, { dialect: "PostgreSQL", schema });

      expect(report.status).toBe("success");
      expect(report.dialect).toBe("PostgreSQL");
      expect(report.legacy).toBe(true);
      expect(report.backup.kind).toBe("pre-reset");
      expect(report.migration.appliedVersion).toBe(1);
      expect(report.verify.status).toBe("verified");
      expect(report.schema).toBe(schema);
      // 报告脱敏：无路径、无连接串、无 schema 名以外的主机信息。
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain("127.0.0.1");
      expect(serialized).not.toContain("postgresql://");

      // JSONL reset：sessions//projects/ 两个根被删除；models.json/凭证/cwd 内容全部保留。
      expect(existsSync(path.join(dataDir, "sessions"))).toBe(false);
      expect(existsSync(path.join(dataDir, "projects"))).toBe(false);
      expect(readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe('{"models":[]}\n');
      expect(readFileSync(credential, "utf8")).toBe('{"token":"never-touch"}\n');
      expect(readFileSync(path.join(cwd, "unrelated.txt"), "utf8")).toBe("cwd survives\n");

      // Reset 只影响 allowlisted schema：ledger 已重建，bystander schema 与 public 数据完好。
      const ledger = await pool.query(`SELECT version FROM ${ident(schema)}.schema_migrations ORDER BY version`);
      expect(ledger.rows.length).toBeGreaterThan(0);
      const bystanderSurvived = await admin!.query(
        `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1`,
        [bystander],
      );
      expect(bystanderSurvived.rows[0]?.count).toBe(0); // schema 本身仍在（空），未被 drop
      const bystanderNamespace = await admin!.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [bystander]);
      expect(bystanderNamespace.rows).toHaveLength(1);
      const legacyGone = await admin!.query(
        "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'legacy_rc_table'",
        [schema],
      );
      expect(legacyGone.rows[0]?.count).toBe(0);

      // 加密备份包可解密且记录 legacy 无 ledger。
      const packages = readdirSync(backupRoot);
      expect(packages).toHaveLength(1);
      const packagePath = path.join(backupRoot, packages[0]!);
      expect(existsSync(path.join(packagePath, "COMPLETE"))).toBe(true);
      const manifest = spawnSync("age", ["--decrypt", "--identity", identity, path.join(packagePath, "manifest.json.age")], { encoding: "utf8" });
      expect(manifest.status).toBe(0);
      const metadata = JSON.parse(manifest.stdout) as { kind: string; migrationLedger: { present: boolean } };
      expect(metadata.kind).toBe("pre-reset");
      expect(metadata.migrationLedger.present).toBe(false);
    } finally {
      await resetGate.cleanup();
      await kysely.destroy();
    }

      // P0 同连接断言：identity 复验与 DROP/CREATE/GRANT 在同一个后端连接上执行。
      expect(gateConnects).toBe(1);
      expect(gatePids.size).toBe(3);
      expect(new Set(gatePids.values()).size).toBe(1);
      for (const pid of gatePids.values()) expect(pid).toMatch(/^\d+$/);
      const normalized = gateQueries.map((text) => text.replace(/\s+/g, " "));
      expect(normalized[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
      expect(normalized.at(-1)).toBe("COMMIT");
      expect(normalized.some((text) => text.includes("current_database()"))).toBe(true);
      expect(normalized).toContain(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      expect(normalized).toContain(`CREATE SCHEMA "${schema}"`);
      expect(normalized.join(" ")).not.toContain("DROP DATABASE");
      expect(normalized.indexOf("COMMIT")).toBeGreaterThan(normalized.findIndex((text) => text.startsWith("DROP SCHEMA")));
  }, 180_000);
});
