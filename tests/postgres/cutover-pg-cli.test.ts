// WP2A 真实 PostgreSQL cutover CLI E2E（随机 pi_cutover_* schema/db，隔离演练）：
// 走真实 CLI 入口（scripts/cutover.ts，经 tsx），验证 env/dialect/target binding、
// dataDir sessions//projects/ JSONL 删除、models.json/凭证保留、public bystander 完好、
// 报告脱敏与 fail path（effective schema 不一致 → 拒绝歧义 reset，零删除）。
// 仅在 PI_TEST_PG_URL + pg_dump/pg_restore/age/age-keygen 可用且由强制 runner
// （scripts/test-cutover-pg.ts，设置 PI_TEST_PG_REQUIRED=1）运行；普通 `pnpm test` 安全 skip。
// fixture 只创建并销毁自己的随机 pi_cutover_* schema 与 public bystander 探针表；
// 绝不 DROP DATABASE、绝不触碰任何真实用户数据库。
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { checkPgBackupBinaries } from "../../scripts/test-pg-backup.js";
import { resolveBinPath } from "../../scripts/test-postgres.js";
import { validateCutoverTargetSchema } from "../../src/cutover/cutover-core.js";

const baseUrl = process.env.PI_TEST_PG_URL?.trim();
const binaryGate = checkPgBackupBinaries();
assertRequiredPgTestEnvironment("tests/postgres/cutover-pg-cli", baseUrl, true);
const describeGate = Boolean(baseUrl) && binaryGate.ok ? describe : describe.skip;
const cleanupSchemas: string[] = [];
const cleanupTables: string[] = [];
let admin: Pool | undefined;

const cutoverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "cutover.ts");

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedUrl(url: string, targetSchema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${targetSchema} -c statement_timeout=30000`);
  return parsed.toString();
}

function writeFixture(root: string): { cwd: string; dataDir: string; agentDir: string; credential: string; recipient: string; identity: string; sessionFile: string; projectSessionFile: string } {
  const cwd = path.join(root, "app-cwd");
  const dataDir = path.join(root, "data");
  const agentDir = path.join(dataDir, ".pi-agent");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "projects", "p1", "sessions", "s2"), { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
  const projectSessionFile = path.join(dataDir, "projects", "p1", "sessions", "s2", "history.jsonl");
  writeFileSync(sessionFile, '{"type":"session","id":"cli"}\n', { mode: 0o600 });
  writeFileSync(projectSessionFile, '{"type":"session","id":"cli-p"}\n', { mode: 0o600 });
  writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  const credential = path.join(root, "creds", "service.auth");
  mkdirSync(path.dirname(credential), { recursive: true, mode: 0o700 });
  writeFileSync(credential, '{"token":"never-touch"}\n', { mode: 0o600 });
  writeFileSync(path.join(cwd, "unrelated.txt"), "cwd survives\n", { mode: 0o600 });
  const identity = path.join(root, "identity");
  const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
  expect(generated.status).toBe(0);
  const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
  expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
  const recipient = path.join(root, "recipient");
  writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });
  chmodSync(recipient, 0o600);
  return { cwd, dataDir, agentDir, credential, recipient, identity, sessionFile, projectSessionFile };
}

function cliEnvironment(fixture: ReturnType<typeof writeFixture>, databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_CWD: fixture.cwd,
    DATA_DIR: fixture.dataDir,
    PI_AGENT_DIR: fixture.agentDir,
    PI_AUTH_PATH: fixture.credential,
    PI_STORAGE_DIALECT: "postgres",
    PI_DATABASE_URL: databaseUrl,
  };
}

function cliArgs(backupRoot: string, recipient: string, targetSchema: string, mode = "--apply"): string[] {
  return [mode, "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA", "--maintenance-window", "CONFIRMED",
    "--backup-root", backupRoot, "--age-recipient-file", recipient, "--target-schema", targetSchema];
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, [resolveBinPath("tsx", "tsx"), cutoverEntry, ...args], { env, encoding: "utf8", timeout: 150_000 });
  return result as SpawnSyncReturns<string>;
}

describeGate("WP2A real PostgreSQL cutover CLI E2E (random pi_cutover_* schema)", () => {
  afterAll(async () => {
    for (const schema of cleanupSchemas) await admin?.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    for (const table of cleanupTables) await admin?.query(`DROP TABLE IF EXISTS public.${ident(table)} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("resets JSONL + allowlisted schema via the real CLI, preserves models/credentials, leaves public bystanders intact, and redacts the report", async () => {
    const schema = validateCutoverTargetSchema(`pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    const bystanderTable = `pi_cutover_cli_bystander_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    cleanupSchemas.push(schema);
    cleanupTables.push(bystanderTable);
    admin = new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    await admin.query(`CREATE TABLE ${ident(schema)}.${ident("legacy_rc_table")} (id int primary key, note text)`);
    await admin.query(`INSERT INTO ${ident(schema)}.${ident("legacy_rc_table")} VALUES (1, 'legacy')`);
    // public bystander 探针：cutover 绝不触碰 public schema 的既有数据。
    await admin.query(`CREATE TABLE public.${ident(bystanderTable)} (id int primary key)`);
    await admin.query(`INSERT INTO public.${ident(bystanderTable)} VALUES (42)`);
    const scoped = scopedUrl(baseUrl!, schema);

    const root = mkdtempSync(path.join(tmpdir(), "pi-cutover-pg-cli-"));
    const fixture = writeFixture(root);
    const backupRoot = path.join(root, "backups");
    const result = runCli(cliArgs(backupRoot, fixture.recipient, schema), cliEnvironment(fixture, scoped));

    expect(result.status).toBe(0);
    const output = result.stdout.trim().split(/\r?\n/);
    const report = JSON.parse(output.at(-1)!) as { status: string; dialect: string; schema: string | null; legacy: boolean };
    expect(report.status).toBe("success");
    expect(report.dialect).toBe("PostgreSQL");
    expect(report.schema).toBe(schema);
    expect(report.legacy).toBe(true);
    // 报告脱敏：任何输出（stdout/stderr）不包含连接串、口令或数据目录路径。
    expect(result.stdout).not.toContain("postgresql://");
    expect(result.stdout).not.toContain(root);
    expect(result.stderr ?? "").not.toContain("postgresql://");
    expect(result.stderr ?? "").not.toContain(root);

    // JSONL reset：sessions//projects/ 两个根被删除；models.json/凭证/cwd 完整保留。
    expect(existsSync(path.join(fixture.dataDir, "sessions"))).toBe(false);
    expect(existsSync(path.join(fixture.dataDir, "projects"))).toBe(false);
    expect(readFileSync(path.join(fixture.agentDir, "models.json"), "utf8")).toBe('{"models":[]}\n');
    expect(readFileSync(fixture.credential, "utf8")).toBe('{"token":"never-touch"}\n');
    expect(readFileSync(path.join(fixture.cwd, "unrelated.txt"), "utf8")).toBe("cwd survives\n");

    // schema reset + migration：ledger 重建，legacy 表被清空，public bystander 完好。
    const ledger = await admin!.query(`SELECT version FROM ${ident(schema)}.schema_migrations ORDER BY version`);
    expect(ledger.rows.length).toBeGreaterThan(0);
    const legacyGone = await admin!.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'legacy_rc_table'", [schema]);
    expect(legacyGone.rows[0]?.count).toBe(0);
    const bystander = await admin!.query(`SELECT count(*)::int AS count FROM public.${ident(bystanderTable)}`);
    expect(bystander.rows[0]?.count).toBe(1);

    // 加密备份包已发布且带 COMPLETE 标记。
    const packages = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
    expect(packages).toHaveLength(1);
    expect(existsSync(path.join(backupRoot, packages[0]!, "COMPLETE"))).toBe(true);
    void fixture.identity;
    rmSync(root, { recursive: true, force: true });
  }, 240_000);

  it("refuses an ambiguous target (effective schema != --target-schema) with zero reset and zero deletion", async () => {
    const schemaA = validateCutoverTargetSchema(`pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    const schemaB = validateCutoverTargetSchema(`pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    cleanupSchemas.push(schemaA);
    admin = admin ?? new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schemaA)}`);
    await admin.query(`CREATE TABLE ${ident(schemaA)}.${ident("legacy_rc_table")} (id int primary key, note text)`);
    await admin.query(`INSERT INTO ${ident(schemaA)}.${ident("legacy_rc_table")} VALUES (1, 'must survive')`);
    const scoped = scopedUrl(baseUrl!, schemaA);

    const root = mkdtempSync(path.join(tmpdir(), "pi-cutover-pg-cli-fail-"));
    const fixture = writeFixture(root);
    const beforeSession = readFileSync(fixture.sessionFile, "utf8");
    const result = runCli(cliArgs(path.join(root, "backups"), fixture.recipient, schemaB), cliEnvironment(fixture, scoped));

    expect(result.status).not.toBe(0);
    // fail path 输出同样脱敏：无连接串、无路径。
    expect(result.stdout).not.toContain("postgresql://");
    expect(result.stderr ?? "").not.toContain("postgresql://");
    expect(result.stderr ?? "").not.toContain(root);
    // 零 reset：legacy 表仍在；零删除：JSONL 根原样。
    const legacy = await admin!.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'legacy_rc_table'", [schemaA]);
    expect(legacy.rows[0]?.count).toBe(1);
    const legacyRow = await admin!.query(`SELECT note FROM ${ident(schemaA)}.${ident("legacy_rc_table")} WHERE id = 1`);
    expect(legacyRow.rows[0]?.note).toBe("must survive");
    expect(readFileSync(fixture.sessionFile, "utf8")).toBe(beforeSession);
    expect(existsSync(path.join(root, "backups")) ? readdirSync(path.join(root, "backups")) : []).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  }, 180_000);

  it("rejects a credential located inside the destructive reset surface before any deletion (fail path)", async () => {
    const schema = validateCutoverTargetSchema(`pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    cleanupSchemas.push(schema);
    admin = admin ?? new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    const scoped = scopedUrl(baseUrl!, schema);

    const root = mkdtempSync(path.join(tmpdir(), "pi-cutover-pg-cli-auth-"));
    const fixture = writeFixture(root);
    // 把 PI_AUTH_PATH 指进 sessions 破坏面内：resolver 必须在任何删除前拒绝。
    const unsafeCredential = path.join(fixture.dataDir, "sessions", "s1", "credential.auth");
    writeFileSync(unsafeCredential, '{"token":"inside"}\n', { mode: 0o600 });
    const env = { ...cliEnvironment(fixture, scoped), PI_AUTH_PATH: unsafeCredential };
    const beforeSession = readFileSync(fixture.sessionFile, "utf8");
    const result = runCli(cliArgs(path.join(root, "backups"), fixture.recipient, schema), env);

    expect(result.status).not.toBe(0);
    expect(result.stderr ?? "").toMatch(/overlaps the destructive reset surface/);
    expect(readFileSync(fixture.sessionFile, "utf8")).toBe(beforeSession);
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }, 180_000);
});
