// WP2A installed npm package smoke: packs the package, installs it, and runs the
// published `pi-agent-server-cutover` bin end to end on an isolated temporary
// legacy SQLite fixture (real age binaries required). Never touches real data.
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.bin?.["pi-agent-server-cutover"] !== "./dist-cutover/scripts/cutover.js" || !packageJson.files?.includes("dist-cutover") || !existsSync("dist-cutover/scripts/cutover.js")) {
  throw new Error("compiled cutover package bin is missing or points outside dist-cutover");
}

const directory = mkdtempSync(path.join(tmpdir(), "pi-cutover-package-smoke-"));
// Hermetic plaintext staging root: the build smoke must never depend on the
// real per-user config staging root (the compiled CLIs honor this variable).
process.env.PI_BACKUP_STAGING_ROOT = mkdtempSync(path.join(tmpdir(), "pi-smoke-staging-"));
const cache = path.join(directory, "npm-cache");
const packageDir = path.join(directory, "package");
const installDir = path.join(directory, "install");
try {
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { ...options, stdio: options.stdio ?? "pipe", encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
    return result;
  };
  const npm = (args) => run("npm", ["--no-audit", "--no-fund", ...args], { env: { ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache } });

  mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const packed = npm(["pack", "--pack-destination", packageDir]);
  const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
  if (!tarball || !existsSync(path.join(packageDir, tarball))) throw new Error("npm pack tarball is missing");
  npm(["install", "--ignore-scripts", "--prefix", installDir, path.join(packageDir, tarball)]);
  const packageRoot = path.join(installDir, "node_modules", packageJson.name);
  const cutoverBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-cutover");
  if (!existsSync(cutoverBin)) throw new Error("installed cutover bin is missing");

  // Legacy fixture built with the installed package's own bootstrap (RC tables, no ledger).
  const { initializeDatabase } = await import(pathToFileURL(path.join(packageRoot, "dist-cutover/src/storage/bootstrap.js")));
  const root = path.join(directory, "fixture");
  const cwd = path.join(root, "app-cwd");
  const dataDir = path.join(root, "data");
  const agentDir = path.join(dataDir, ".pi-agent");
  const backupRoot = path.join(root, "backups");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/legacy"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"legacy","timestamp":1}}\n', { mode: 0o600 });
  writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, "auth.json"), '{"token":"never-touch"}\n', { mode: 0o600 });
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  await initializeDatabase(db);
  db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run("p1", "legacy", "/legacy", "owner", 1);
  db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s1", "owner", "p1", "legacy", 1, 1, sessionFile, "{}");
  db.close();

  const identity = path.join(root, "identity");
  run("age-keygen", ["--output", identity], { stdio: "ignore" });
  const extracted = run("age-keygen", ["-y", identity]);
  const recipient = path.join(root, "recipient.txt");
  const publicKey = extracted.stdout.trim();
  if (!/^age1[0-9a-z]+$/.test(publicKey)) throw new Error("age recipient extraction failed");
  writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });

  const result = run(cutoverBin, [
    "--apply", "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA",
    "--maintenance-window", "CONFIRMED",
    "--backup-root", backupRoot, "--age-recipient-file", recipient,
  ], { env: { ...process.env, AGENT_CWD: cwd, DATA_DIR: dataDir, DB_PATH: dbPath, PI_AGENT_DIR: agentDir } });
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  if (report.status !== "success" || report.legacy !== true || report.backup.kind !== "pre-reset") throw new Error("installed cutover safety report is incomplete");
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const ledger = check.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  check.close();
  if (ledger.length === 0) throw new Error("installed cutover did not rebuild a migration ledger");
  if (existsSync(path.join(dataDir, "sessions")) || existsSync(path.join(dataDir, "projects"))) throw new Error("installed cutover left session JSONL roots behind");
  if (readFileSync(path.join(agentDir, "models.json"), "utf8") !== '{"models":[]}\n') throw new Error("installed cutover deleted the whitelisted service config");
  if (readFileSync(path.join(dataDir, "auth.json"), "utf8") !== '{"token":"never-touch"}\n') throw new Error("installed cutover deleted the credential file");
  const packages = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (packages.length !== 1 || !existsSync(path.join(backupRoot, packages[0], "COMPLETE"))) throw new Error("installed cutover did not publish a COMPLETE pre-reset package");

  // Safety-failure smoke stays independent of the successful E2E path: a fresh
  // failDataDir with its own legacy DB/JSONL, a single verbatim-mismatched
  // confirmation token, and zero deletion asserted afterwards.
  const failRoot = path.join(root, "fail-fixture");
  const failCwd = path.join(failRoot, "app-cwd");
  const failDataDir = path.join(failRoot, "data");
  const failAgentDir = path.join(failDataDir, ".pi-agent");
  const failBackupRoot = path.join(failRoot, "backups");
  mkdirSync(failCwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(failDataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(failAgentDir, { recursive: true, mode: 0o700 });
  const failSession = path.join(failDataDir, "sessions", "s1", "history.jsonl");
  writeFileSync(failSession, '{"type":"session","version":3,"id":"fail-header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/legacy"}\n', { mode: 0o600 });
  writeFileSync(path.join(failAgentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  const failDbPath = path.join(failDataDir, "pi-agent-server.db");
  const failDb = new DatabaseSync(failDbPath);
  await initializeDatabase(failDb);
  failDb.close();
  const failDbBefore = readFileSync(failDbPath).toString();
  const failSessionBefore = readFileSync(failSession).toString();
  const failed = spawnSync(cutoverBin, [
    "--apply", "--reset-rc-data", "--confirm-reset", "wrong-token",
    "--maintenance-window", "CONFIRMED",
    "--backup-root", failBackupRoot, "--age-recipient-file", recipient,
  ], { env: { ...process.env, AGENT_CWD: failCwd, DATA_DIR: failDataDir, DB_PATH: failDbPath, PI_AGENT_DIR: failAgentDir }, encoding: "utf8" });
  if (failed.status === 0) throw new Error("installed cutover accepted a wrong confirmation token");
  if (readFileSync(failDbPath).toString() !== failDbBefore || readFileSync(failSession).toString() !== failSessionBefore) {
    throw new Error("installed cutover deleted data without a valid confirmation");
  }
  if (existsSync(failBackupRoot)) throw new Error("installed cutover published a backup without a valid confirmation");
  if (failed.stderr.includes(failDataDir)) throw new Error("installed cutover safe-failure smoke failed");
  console.log("installed npm cutover E2E and safe-failure smoke: ok");

  // Real PostgreSQL E2E via the installed bin (random pi_cutover_* schema; skipped without
  // PI_TEST_PG_URL/binaries — the release gate test:cutover-pg fails closed on missing URL).
  const pgUrl = process.env.PI_TEST_PG_URL?.trim() ?? "";
  const pgBinaries = ["pg_dump", "pg_restore", "age", "age-keygen"]
    .filter((binary) => spawnSync(binary, ["--version"], { stdio: "ignore" }).status !== 0);
  if (pgUrl === "" || pgBinaries.length > 0) {
    console.log(`installed npm cutover PG E2E: skipped (${pgUrl === "" ? "PI_TEST_PG_URL not set" : `missing binaries: ${pgBinaries.join(", ")}`})`);
  } else {
  const { Client } = await import("pg");
  const schema = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const schemaB = `pi_cutover_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const bystanderTable = `pi_cutover_pkg_bystander_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    const pgRoot = path.join(root, "pg-fixture");
    const pgCwd = path.join(pgRoot, "app-cwd");
    const pgDataDir = path.join(pgRoot, "data");
    const pgAgentDir = path.join(pgDataDir, ".pi-agent");
    mkdirSync(pgCwd, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(pgDataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(pgAgentDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(pgDataDir, "sessions", "s1", "history.jsonl"), '{"type":"session","id":"pkg-pg"}\n', { mode: 0o600 });
    writeFileSync(path.join(pgAgentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
    const pgCredential = path.join(pgRoot, "creds", "service.auth");
    mkdirSync(path.dirname(pgCredential), { recursive: true, mode: 0o700 });
    writeFileSync(pgCredential, '{"token":"never-touch"}\n', { mode: 0o600 });
    const pgEnv = { ...process.env, AGENT_CWD: pgCwd, DATA_DIR: pgDataDir, PI_AGENT_DIR: pgAgentDir, PI_AUTH_PATH: pgCredential, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: scopedUrl(schema) };
    const pgResult = spawnSync(cutoverBin, ["--apply", "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA", "--maintenance-window", "CONFIRMED",
      "--backup-root", path.join(pgRoot, "backups"), "--age-recipient-file", recipient, "--target-schema", schema],
      { env: pgEnv, encoding: "utf8", timeout: 150_000 });
    if (pgResult.status !== 0) throw new Error(`installed cutover PG apply failed: ${pgResult.stderr}`);
    const pgReport = JSON.parse(pgResult.stdout.trim().split(/\r?\n/).at(-1));
    if (pgReport.status !== "success" || pgReport.dialect !== "PostgreSQL" || pgReport.schema !== schema) {
      throw new Error("installed cutover PG success report is incomplete");
    }
    if (pgResult.stdout.includes("postgresql://") || pgResult.stdout.includes(pgRoot) || (pgResult.stderr ?? "").includes("postgresql://")) {
      throw new Error("installed cutover PG output leaked the connection URL or fixture paths");
    }
    if (existsSync(path.join(pgDataDir, "sessions")) || existsSync(path.join(pgDataDir, "projects"))) {
      throw new Error("installed cutover PG left session JSONL roots behind");
    }
    if (readFileSync(path.join(pgAgentDir, "models.json"), "utf8") !== '{"models":[]}\n') throw new Error("installed cutover PG deleted the whitelisted service config");
    if (readFileSync(pgCredential, "utf8") !== '{"token":"never-touch"}\n') throw new Error("installed cutover PG deleted the credential file");
    const ledger = await admin.query(`SELECT version FROM ${ident(schema)}.schema_migrations ORDER BY version`);
    if (ledger.rows.length === 0) throw new Error("installed cutover PG did not rebuild a migration ledger");
    const legacyGone = await admin.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'legacy_rc_table'", [schema]);
    if (legacyGone.rows[0].count !== 0) throw new Error("installed cutover PG left the legacy table in place");
    const bystander = await admin.query(`SELECT count(*)::int AS count FROM public.${ident(bystanderTable)}`);
    if (bystander.rows[0].count !== 1) throw new Error("installed cutover PG touched a public bystander table");

    // Fail path：effective schema 与 --target-schema 不一致 → 拒绝歧义 reset，零删除。
    await admin.query(`CREATE TABLE ${ident(schema)}.${ident("must_survive")} (id int primary key)`);
    await admin.query(`INSERT INTO ${ident(schema)}.${ident("must_survive")} VALUES (1)`);
    const failRoot = path.join(root, "pg-fail-fixture");
    const failDataDir = path.join(failRoot, "data");
    mkdirSync(path.join(failDataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    const failSession = path.join(failDataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(failSession, '{"type":"session","id":"fail"}\n', { mode: 0o600 });
    const failed = spawnSync(cutoverBin, ["--apply", "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA", "--maintenance-window", "CONFIRMED",
      "--backup-root", path.join(failRoot, "backups"), "--age-recipient-file", recipient, "--target-schema", schemaB],
      { env: { ...pgEnv, PI_DATABASE_URL: scopedUrl(schema) }, encoding: "utf8", timeout: 60_000 });
    if (failed.status === 0) throw new Error("installed cutover PG accepted a mismatched --target-schema");
    if (readFileSync(failSession, "utf8") !== '{"type":"session","id":"fail"}\n') throw new Error("installed cutover PG deleted JSONL on the fail path");
    const survivor = await admin.query(`SELECT count(*)::int AS count FROM ${ident(schema)}.${ident("must_survive")}`);
    if (survivor.rows[0].count !== 1) throw new Error("installed cutover PG reset a schema on the fail path");
    console.log("installed npm cutover real-PostgreSQL E2E and fail-path smoke: ok");
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    await admin.query(`DROP TABLE IF EXISTS public.${ident(bystanderTable)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
  }
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
