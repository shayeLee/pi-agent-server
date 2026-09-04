// WP2A compiled cutover CLI smoke: runs dist-cutover/scripts/cutover.js against an
// isolated temporary legacy SQLite fixture (real age binaries required). Never
// touches any real user data; the fixture lives entirely in a temp directory.
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";

// 发布产物卫生：编译产物树中不允许出现已移除执行器的残留文件或任何符号链接。
checkDistHygiene("dist-cutover");

const cutoverBin = path.resolve("dist-cutover/scripts/cutover.js");
if (!existsSync(cutoverBin)) throw new Error("compiled cutover CLI is missing (build:cutover must run first)");
const { initializeDatabase } = await import(pathToFileURL(path.resolve("dist-cutover/src/storage/bootstrap.js")));

// 真实 PG E2E 前置：PI_TEST_PG_URL + pg_dump/pg_restore/age/age-keygen；缺失时打印 skip 原因
// （release 门禁 test:cutover-pg 是强制 runner，URL 缺失时非零失败，不在此处重复发连接）。
const pgUrl = process.env.PI_TEST_PG_URL?.trim() ?? "";
const pgBinaries = ["pg_dump", "pg_restore", "age", "age-keygen"]
  .filter((binary) => spawnSync(binary, ["--version"], { stdio: "ignore" }).status !== 0);
const runRealPg = pgUrl !== "" && pgBinaries.length === 0;

const directory = mkdtempSync(path.join(tmpdir(), "pi-cutover-build-smoke-"));
// Hermetic plaintext staging root: the build smoke must never depend on the
// real per-user config staging root (the compiled CLIs honor this variable).
process.env.PI_BACKUP_STAGING_ROOT = mkdtempSync(path.join(tmpdir(), "pi-smoke-staging-"));
const results = [];
try {
  const createFixture = async () => {
    const root = path.join(directory, `fixture-${results.length}`);
    const cwd = path.join(root, "app-cwd");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(dataDir, ".pi-agent");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/legacy"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"legacy","timestamp":1}}\n', { mode: 0o600 });
    writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
    writeFileSync(path.join(dataDir, "auth.json"), '{"token":"never-touch"}\n', { mode: 0o600 });
    writeFileSync(path.join(cwd, "unrelated.txt"), "cwd survives\n", { mode: 0o600 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    await initializeDatabase(db);
    db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run("p1", "legacy", "/legacy", "owner", 1);
    db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s1", "owner", "p1", "legacy", 1, 1, sessionFile, "{}");
    db.close();
    return { root, cwd, dataDir, agentDir, dbPath, backupRoot: path.join(root, "backups") };
  };

  const ageKey = () => {
    const identity = path.join(directory, "identity");
    const recipient = path.join(directory, "recipient.txt");
    if (!existsSync(identity)) {
      const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
      if (generated.status !== 0) throw new Error("age-keygen unavailable; compiled cutover smoke cannot run");
      const extracted = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" });
      const publicKey = extracted.stdout.trim();
      if (!/^age1[0-9a-z]+$/.test(publicKey)) throw new Error("age recipient extraction failed");
      writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });
    }
    return { identity, recipient: path.join(directory, "recipient.txt") };
  };

  const env = (fixture) => ({ ...process.env, AGENT_CWD: fixture.cwd, DATA_DIR: fixture.dataDir, DB_PATH: fixture.dbPath, PI_AGENT_DIR: fixture.agentDir });
  const args = (fixture, recipient, mode = "--apply", overrides = []) => [
    mode, "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA",
    "--maintenance-window", "CONFIRMED",
    "--backup-root", fixture.backupRoot, "--age-recipient-file", recipient,
    ...overrides,
  ];
  // 单错误 token 的参数（不含正确 token，避免重复 flag 触发解析拒绝而非逐字校验拒绝）。
  const wrongTokenArgs = (fixture, recipient, wrongToken, mode = "--apply") => [
    mode, "--reset-rc-data", "--confirm-reset", wrongToken,
    "--maintenance-window", "CONFIRMED",
    "--backup-root", fixture.backupRoot, "--age-recipient-file", recipient,
  ];

  // 1. Wrong confirmation token (single, verbatim-mismatched token): non-zero exit, zero deletion, no backup package.
  ageKey();
  const wrongFixture = await createFixture();
  const dbBefore = readFileSync(wrongFixture.dbPath);
  const wrong = spawnSync(process.execPath, [cutoverBin, ...wrongTokenArgs(wrongFixture, path.join(directory, "recipient.txt"), "delete_rc_data")], { env: env(wrongFixture), encoding: "utf8" });
  if (wrong.status === 0) throw new Error("compiled cutover accepted a wrong confirmation token");
  if (readFileSync(wrongFixture.dbPath).toString() !== dbBefore.toString()) throw new Error("compiled cutover deleted data without a valid confirmation");
  if (existsSync(wrongFixture.backupRoot)) throw new Error("compiled cutover published a backup without a valid confirmation");
  results.push("wrong-confirmation");

  // 2. Dry-run: zero writes (no backup root, DB untouched).
  const dryFixture = await createFixture();
  const dryDb = readFileSync(dryFixture.dbPath);
  const dry = spawnSync(process.execPath, [cutoverBin, ...args(dryFixture, path.join(directory, "recipient.txt"), "--dry-run")], { env: env(dryFixture), encoding: "utf8" });
  if (dry.status !== 0) throw new Error("compiled cutover dry-run failed");
  JSON.parse(dry.stdout.trim().split(/\r?\n/).at(-1));
  if (existsSync(dryFixture.backupRoot) || readFileSync(dryFixture.dbPath).toString() !== dryDb.toString()) throw new Error("compiled cutover dry-run wrote to the target");
  results.push("dry-run");

  // 3. Full apply: legacy DB + JSONL reset, models.json preserved, migrated baseline, encrypted package.
  const fixture = await createFixture();
  const { recipient } = ageKey();
  const apply = spawnSync(process.execPath, [cutoverBin, ...args(fixture, recipient, "--apply")], { env: env(fixture), encoding: "utf8" });
  if (apply.status !== 0) throw new Error(`compiled cutover apply failed: ${apply.stderr}`);
  const report = JSON.parse(apply.stdout.trim().split(/\r?\n/).at(-1));
  if (report.status !== "success" || report.dialect !== "SQLite" || report.legacy !== true || report.backup.kind !== "pre-reset") {
    throw new Error("compiled cutover success report is incomplete or not legacy-marked");
  }
  const check = new DatabaseSync(fixture.dbPath, { readOnly: true });
  const ledger = check.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  check.close();
  if (ledger.length === 0) throw new Error("compiled cutover did not rebuild a migration ledger");
  if (existsSync(path.join(fixture.dataDir, "sessions")) || existsSync(path.join(fixture.dataDir, "projects"))) {
    throw new Error("compiled cutover left session JSONL roots behind");
  }
  if (readFileSync(path.join(fixture.agentDir, "models.json"), "utf8") !== '{"models":[]}\n') throw new Error("compiled cutover deleted the whitelisted service config");
  if (readFileSync(path.join(fixture.dataDir, "auth.json"), "utf8") !== '{"token":"never-touch"}\n') throw new Error("compiled cutover deleted the credential file");
  if (readFileSync(path.join(fixture.cwd, "unrelated.txt"), "utf8") !== "cwd survives\n") throw new Error("compiled cutover deleted cwd content");
  const packages = readdirSync(fixture.backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (packages.length !== 1 || !existsSync(path.join(fixture.backupRoot, packages[0], "COMPLETE"))) throw new Error("compiled cutover did not publish a COMPLETE pre-reset package");
  results.push("apply");

  // 4. Real PostgreSQL E2E（随机 pi_cutover_* schema）：env/dialect/target binding、
  //    JSONL 删除、models/凭证保留、public bystander 完好、报告脱敏、fail path。
  if (!runRealPg) {
    console.log(`compiled cutover PG E2E: skipped (${pgUrl === "" ? "PI_TEST_PG_URL not set" : `missing binaries: ${pgBinaries.join(", ")}`})`);
  } else {
    const { Client } = await import("pg");
    const schema = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const schemaB = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const bystanderTable = `pi_cutover_compiled_bystander_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = new Client({ connectionString: pgUrl });
    await admin.connect();
    const ident = (value) => `"${value.replaceAll('"', '""')}"`;
    const scopedUrl = (targetSchema) => {
      const parsed = new URL(pgUrl);
      parsed.searchParams.set("options", `-c search_path=${targetSchema} -c statement_timeout=30000`);
      return parsed.toString();
    };
    try {
      await admin.query(`CREATE SCHEMA ${ident(schema)}`);
      await admin.query(`CREATE TABLE ${ident(schema)}.${ident("legacy_rc_table")} (id int primary key, note text)`);
      await admin.query(`INSERT INTO ${ident(schema)}.${ident("legacy_rc_table")} VALUES (1, 'legacy')`);
      await admin.query(`CREATE TABLE public.${ident(bystanderTable)} (id int primary key)`);
      await admin.query(`INSERT INTO public.${ident(bystanderTable)} VALUES (42)`);
      const pgRoot = path.join(directory, "pg-fixture");
      const pgCwd = path.join(pgRoot, "app-cwd");
      const pgDataDir = path.join(pgRoot, "data");
      const pgAgentDir = path.join(pgDataDir, ".pi-agent");
      mkdirSync(pgCwd, { recursive: true, mode: 0o700 });
      mkdirSync(path.join(pgDataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
      mkdirSync(pgAgentDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(pgDataDir, "sessions", "s1", "history.jsonl"), '{"type":"session","id":"compiled-pg"}\n', { mode: 0o600 });
      writeFileSync(path.join(pgAgentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
      const pgCredential = path.join(pgRoot, "creds", "service.auth");
      mkdirSync(path.dirname(pgCredential), { recursive: true, mode: 0o700 });
      writeFileSync(pgCredential, '{"token":"never-touch"}\n', { mode: 0o600 });
      const { recipient } = ageKey();
      const pgEnv = { ...process.env, AGENT_CWD: pgCwd, DATA_DIR: pgDataDir, PI_AGENT_DIR: pgAgentDir, PI_AUTH_PATH: pgCredential, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: scopedUrl(schema) };
      const pgArgs = ["--apply", "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA", "--maintenance-window", "CONFIRMED",
        "--backup-root", path.join(pgRoot, "backups"), "--age-recipient-file", recipient, "--target-schema", schema];
      const pgResult = spawnSync(process.execPath, [cutoverBin, ...pgArgs], { env: pgEnv, encoding: "utf8", timeout: 150_000 });
      if (pgResult.status !== 0) throw new Error(`compiled cutover PG apply failed: ${pgResult.stderr}`);
      const pgReport = JSON.parse(pgResult.stdout.trim().split(/\r?\n/).at(-1));
      if (pgReport.status !== "success" || pgReport.dialect !== "PostgreSQL" || pgReport.schema !== schema) {
        throw new Error("compiled cutover PG success report is incomplete");
      }
      if (pgResult.stdout.includes("postgresql://") || pgResult.stdout.includes(pgRoot) || (pgResult.stderr ?? "").includes("postgresql://")) {
        throw new Error("compiled cutover PG output leaked the connection URL or fixture paths");
      }
      if (existsSync(path.join(pgDataDir, "sessions")) || existsSync(path.join(pgDataDir, "projects"))) {
        throw new Error("compiled cutover PG left session JSONL roots behind");
      }
      if (readFileSync(path.join(pgAgentDir, "models.json"), "utf8") !== '{"models":[]}\n') throw new Error("compiled cutover PG deleted the whitelisted service config");
      if (readFileSync(pgCredential, "utf8") !== '{"token":"never-touch"}\n') throw new Error("compiled cutover PG deleted the credential file");
      const ledger = await admin.query(`SELECT version FROM ${ident(schema)}.schema_migrations ORDER BY version`);
      if (ledger.rows.length === 0) throw new Error("compiled cutover PG did not rebuild a migration ledger");
      const legacyGone = await admin.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'legacy_rc_table'", [schema]);
      if (legacyGone.rows[0].count !== 0) throw new Error("compiled cutover PG left the legacy table in place");
      const bystander = await admin.query(`SELECT count(*)::int AS count FROM public.${ident(bystanderTable)}`);
      if (bystander.rows[0].count !== 1) throw new Error("compiled cutover PG touched a public bystander table");
      results.push("pg-apply");

      // Fail path：effective schema 与 --target-schema 不一致 → 拒绝歧义 reset，零删除。
      await admin.query(`CREATE TABLE ${ident(schema)}.${ident("must_survive")} (id int primary key)`);
      await admin.query(`INSERT INTO ${ident(schema)}.${ident("must_survive")} VALUES (1)`);
      const failRoot = path.join(directory, "pg-fail-fixture");
      const failDataDir = path.join(failRoot, "data");
      mkdirSync(path.join(failDataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
      const failSession = path.join(failDataDir, "sessions", "s1", "history.jsonl");
      writeFileSync(failSession, '{"type":"session","id":"fail"}\n', { mode: 0o600 });
      const failEnv = { ...pgEnv, DATA_DIR: failDataDir, PI_AGENT_DIR: path.join(failDataDir, ".pi-agent"), PI_DATABASE_URL: scopedUrl(schema) };
      const failed = spawnSync(process.execPath, [cutoverBin, "--apply", "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA", "--maintenance-window", "CONFIRMED",
        "--backup-root", path.join(failRoot, "backups"), "--age-recipient-file", path.join(directory, "recipient.txt"), "--target-schema", schemaB],
        { env: failEnv, encoding: "utf8", timeout: 60_000 });
      if (failed.status === 0) throw new Error("compiled cutover PG accepted a mismatched --target-schema");
      if (readFileSync(failSession, "utf8") !== '{"type":"session","id":"fail"}\n') throw new Error("compiled cutover PG deleted JSONL on the fail path");
      const survivor = await admin.query(`SELECT count(*)::int AS count FROM ${ident(schema)}.${ident("must_survive")}`);
      if (survivor.rows[0].count !== 1) throw new Error("compiled cutover PG reset a schema on the fail path");
      results.push("pg-fail");
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
      await admin.query(`DROP TABLE IF EXISTS public.${ident(bystanderTable)} CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }

  console.log(`compiled cutover E2E and safe-failure smokes: ok (${results.join(", ")})`);
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
