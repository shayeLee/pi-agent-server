// WP5D-4 installed npm package smoke: packs the package, installs it, and runs the
// published `pi-agent-server-owner-transfer` bin end to end on an isolated temporary
// SQLite fixture (real age binaries required) and, when PI_TEST_PG_URL + pg binaries
// are set, a real random isolated PG schema. Never touches real data.
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.bin?.["pi-agent-server-owner-transfer"] !== "./dist-owner-transfer/scripts/owner-transfer.js" || !packageJson.files?.includes("dist-owner-transfer") || !existsSync("dist-owner-transfer/scripts/owner-transfer.js")) {
  throw new Error("compiled owner-transfer package bin is missing or points outside dist-owner-transfer");
}

const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const SOURCE = "10.1.2.3";
const TARGET = "10.1.2.4";
const SOURCE_OWNER = `ip:${SOURCE}`;
const TARGET_OWNER = `ip:${TARGET}`;

const directory = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-package-smoke-"));
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
  const ownerTransferBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-owner-transfer");
  if (!existsSync(ownerTransferBin)) throw new Error("installed owner-transfer bin is missing");
  if (!existsSync(path.join(packageRoot, "dist-owner-transfer", "scripts", "owner-transfer.js"))) throw new Error("installed package lacks dist-owner-transfer");

  const { initializeDatabase } = await import(pathToFileURL(path.join(packageRoot, "dist-owner-transfer/src/storage/bootstrap.js")));
  const { createPostgresKysely: createPostgresKyselyInstalled, createPostgresPool: createPostgresPoolInstalled } = await import(pathToFileURL(path.join(packageRoot, "dist-owner-transfer/src/storage/postgres-bootstrap.js")));
  const { runPostgresMigrations: runPostgresMigrationsInstalled } = await import(pathToFileURL(path.join(packageRoot, "dist-owner-transfer/src/storage/migration-engine.js")));
  const root = path.join(directory, "fixture");
  const cwd = path.join(root, "app-cwd");
  const dataDir = path.join(root, "data");
  const agentDir = path.join(dataDir, ".pi-agent");
  const backupRoot = path.join(root, "backups");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/cwd"}\n', { mode: 0o600 });
  writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, "auth.json"), '{"token":"never-touch"}\n', { mode: 0o600 });
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  await initializeDatabase(db);
  db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run(DEFAULT_PROJECT_ID, "默认项目", cwd, "", 0);
  db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run("p1", "custom", "/cwd", SOURCE_OWNER, 1);
  db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s1", SOURCE_OWNER, DEFAULT_PROJECT_ID, "default", 1, 1, sessionFile, "{}");
  db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s2", SOURCE_OWNER, "p1", "custom", 1, 1, null, "{}");
  db.close();

  const identity = path.join(root, "identity");
  run("age-keygen", ["--output", identity], { stdio: "ignore" });
  const extracted = run("age-keygen", ["-y", identity]);
  const recipient = path.join(root, "recipient.txt");
  const publicKey = extracted.stdout.trim();
  if (!/^age1[0-9a-z]+$/.test(publicKey)) throw new Error("age recipient extraction failed");
  writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });

  const binArgs = (mode = "--apply") => [mode, "--source-ip", SOURCE, "--target-ip", TARGET,
    "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
    "--backup-root", backupRoot, "--age-recipient-file", recipient];
  const binEnv = { ...process.env, AGENT_CWD: cwd, DATA_DIR: dataDir, DB_PATH: dbPath, PI_AGENT_DIR: agentDir, PI_AUTH_PATH: path.join(dataDir, "auth.json") };

  const result = run(ownerTransferBin, binArgs("--apply"), { env: binEnv });
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  if (report.status !== "success" || report.backup.kind !== "pre-owner-transfer" || report.transfer.projectsTransferred !== 1 || report.transfer.sessionsTransferred !== 2) {
    throw new Error("installed owner-transfer safety report is incomplete");
  }
  if (!/^[0-9a-f]{16}$/.test(report.sourceSubjectHash) || !/^[0-9a-f]{16}$/.test(report.targetSubjectHash)) throw new Error("installed owner-transfer report has no subject hashes");
  if (JSON.stringify(report).includes(SOURCE) || JSON.stringify(report).includes(TARGET) || JSON.stringify(report).includes(dataDir) || JSON.stringify(report).includes(dbPath)) {
    throw new Error("installed owner-transfer report leaked IP/path values");
  }
  const check = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
  const ownerMap = (rows) => Object.fromEntries(rows.map((row) => [String(row.id), String(row.owner_key)]));
  const projects = ownerMap(check.prepare("SELECT id, owner_key FROM projects").all());
  const sessions = ownerMap(check.prepare("SELECT id, owner_key FROM sessions").all());
  check.close();
  if (projects[DEFAULT_PROJECT_ID] !== "" || projects.p1 !== TARGET_OWNER || sessions.s1 !== TARGET_OWNER || sessions.s2 !== TARGET_OWNER) {
    throw new Error("installed owner-transfer did not transfer the exact owner rows");
  }
  if (readFileSync(path.join(agentDir, "models.json"), "utf8") !== '{"models":[]}\n') throw new Error("installed owner-transfer deleted the whitelisted service config");
  if (readFileSync(path.join(dataDir, "auth.json"), "utf8") !== '{"token":"never-touch"}\n') throw new Error("installed owner-transfer touched the credential file");
  if (!existsSync(path.join(dataDir, "sessions", "s1", "history.jsonl"))) throw new Error("installed owner-transfer deleted session JSONL");
  const packages = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (packages.length !== 1 || !existsSync(path.join(backupRoot, packages[0], "COMPLETE"))) throw new Error("installed owner-transfer did not publish a COMPLETE pre-owner-transfer package");

  // Fail path: wrong confirmation token → non-zero, zero writes, no backup.
  const failFixture = path.join(root, "fail-fixture");
  const failCwd = path.join(failFixture, "app-cwd");
  const failDataDir = path.join(failFixture, "data");
  const failAgentDir = path.join(failDataDir, ".pi-agent");
  mkdirSync(failCwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(failDataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(failAgentDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(failDataDir, "sessions", "s1", "history.jsonl"), '{"type":"session","id":"fail"}\n', { mode: 0o600 });
  writeFileSync(path.join(failAgentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  writeFileSync(path.join(failDataDir, "auth.json"), '{"token":"never-touch"}\n', { mode: 0o600 });
  const failDbPath = path.join(failDataDir, "pi-agent-server.db");
  const failDb = new DatabaseSync(failDbPath);
  await initializeDatabase(failDb);
  failDb.close();
  const failDbBefore = readFileSync(failDbPath).toString();
  const failSessionBefore = readFileSync(path.join(failDataDir, "sessions", "s1", "history.jsonl")).toString();
  const failed = spawnSync(ownerTransferBin, binArgs("--apply").map((arg) => arg === "TRANSFER_IP_OWNERSHIP" ? "transfer_ip_ownership" : arg), {
    env: { ...process.env, AGENT_CWD: failCwd, DATA_DIR: failDataDir, DB_PATH: failDbPath, PI_AGENT_DIR: failAgentDir, PI_AUTH_PATH: path.join(failDataDir, "auth.json") }, encoding: "utf8",
  });
  if (failed.status === 0) throw new Error("installed owner-transfer accepted a wrong confirmation token");
  if (readFileSync(failDbPath).toString() !== failDbBefore || readFileSync(path.join(failDataDir, "sessions", "s1", "history.jsonl")).toString() !== failSessionBefore) {
    throw new Error("installed owner-transfer wrote data without a valid confirmation");
  }
  if (existsSync(path.join(failFixture, "backups"))) throw new Error("installed owner-transfer published a backup without a valid confirmation");
  if (failed.stderr.includes(failDataDir)) throw new Error("installed owner-transfer safe-failure smoke leaked paths");

  // Missing session-reference JSONL (missing-as-empty, Phase 3): the installed
  // CLI publishes the pre-owner-transfer backup (reference recorded in the
  // manifest) and the transfer performs the owner changes.
  const missFixture = path.join(root, "miss-fixture");
  const missCwd = path.join(missFixture, "app-cwd");
  const missDataDir = path.join(missFixture, "data");
  const missAgentDir = path.join(missDataDir, ".pi-agent");
  mkdirSync(missCwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(missDataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(missAgentDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(missDataDir, "sessions", "s1", "history.jsonl"), '{"type":"session","id":"miss"}\n', { mode: 0o600 });
  writeFileSync(path.join(missAgentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  writeFileSync(path.join(missDataDir, "auth.json"), '{"token":"never-touch"}\n', { mode: 0o600 });
  const missDbPath = path.join(missDataDir, "pi-agent-server.db");
  const missDb = new DatabaseSync(missDbPath);
  await initializeDatabase(missDb);
  missDb.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run(DEFAULT_PROJECT_ID, "默认项目", missCwd, "", 0);
  missDb.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run("p1", "custom", "/cwd", SOURCE_OWNER, 1);
  missDb.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s1", SOURCE_OWNER, DEFAULT_PROJECT_ID, "t", 1, 1, path.join(missDataDir, "sessions", "s1", "ghost.jsonl"), "{}");
  missDb.close();
  // The installed bin uses the shared backup root; snapshot its published
  // package count before the run so we can prove exactly one more was added.
  const sharedPackagesBefore = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
  const missingRef = spawnSync(ownerTransferBin, binArgs("--apply"), {
    env: { ...process.env, AGENT_CWD: missCwd, DATA_DIR: missDataDir, DB_PATH: missDbPath, PI_AGENT_DIR: missAgentDir, PI_AUTH_PATH: path.join(missDataDir, "auth.json") }, encoding: "utf8",
  });
  if (missingRef.status !== 0) throw new Error(`installed owner-transfer failed with a missing session reference (missing-as-empty): ${missingRef.stderr}`);
  if ((missingRef.stderr ?? "").includes(missDataDir)) throw new Error("installed owner-transfer safe-failure smoke leaked paths");
  const missOwners = (() => {
    const check = new DatabaseSync(missDbPath, { readOnly: true, enableForeignKeyConstraints: true });
    try {
      const projects = Object.fromEntries((check.prepare("SELECT id, owner_key FROM projects").all()).map((row) => [String(row.id), String(row.owner_key)]));
      const sessions = Object.fromEntries((check.prepare("SELECT id, owner_key FROM sessions").all()).map((row) => [String(row.id), String(row.owner_key)]));
      return { projects, sessions };
    } finally { check.close(); }
  })();
  if (missOwners.projects[DEFAULT_PROJECT_ID] !== "" || missOwners.projects.p1 !== TARGET_OWNER || missOwners.sessions.s1 !== TARGET_OWNER) {
    throw new Error("installed owner-transfer did not transfer exact owner rows with a missing reference");
  }
  const sharedPackagesAfter = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (sharedPackagesAfter.length !== sharedPackagesBefore.length + 1 || !existsSync(path.join(backupRoot, sharedPackagesAfter.at(-1), "COMPLETE"))) {
    throw new Error("installed owner-transfer did not publish a new COMPLETE package despite the missing reference");
  }
  console.log("installed npm owner-transfer E2E, safe-failure smoke and missing-as-empty smoke: ok");

  // Real PostgreSQL E2E via the installed bin (random isolated schema; skipped without PI_TEST_PG_URL/binaries).
  const pgUrl = process.env.PI_TEST_PG_URL?.trim() ?? "";
  const pgBinaries = ["pg_dump", "pg_restore", "age", "age-keygen"]
    .filter((binary) => spawnSync(binary, ["--version"], { stdio: "ignore" }).status !== 0);
  if (pgUrl === "" || pgBinaries.length > 0) {
    console.log(`installed npm owner-transfer PG E2E: skipped (${pgUrl === "" ? "PI_TEST_PG_URL not set" : `missing binaries: ${pgBinaries.join(", ")}`})`);
  } else {
    const PG_CUSTOM_PROJECT_ID = "4d5e6f70-8192-4abc-8def-0123456789ab";
    const PG_SESSION_ONE_ID = "5e6f7081-92a3-4bcd-8efa-1234567890bc";
    const { Client } = await import("pg");
    const schema = `ot_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
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
      // Build the canonical schema (all managed tables + schema_migrations ledger)
      // in the scoped non-public schema with the installed package's migration
      // engine. The prior manual DDL was a legacy shape lacking schema_migrations,
      // which the pre-owner-transfer backup ledger requires; the production
      // backup ledger rule is unchanged.
      {
        const seedPool = createPostgresPoolInstalled(scopedUrl(schema));
        const seedDb = createPostgresKyselyInstalled(seedPool);
        try {
          await runPostgresMigrationsInstalled(seedDb, { mode: "apply" });
        } finally {
          await seedDb.destroy();
        }
      }
      await admin.query(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [DEFAULT_PROJECT_ID, "默认项目", "/cwd", "", 0]);
      await admin.query(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [PG_CUSTOM_PROJECT_ID, "custom", "/cwd", SOURCE_OWNER, 1]);
      await admin.query(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [PG_SESSION_ONE_ID, SOURCE_OWNER, DEFAULT_PROJECT_ID, "t", 1, 1, null, "{}"]);
      const pgRoot = path.join(root, "pg-fixture");
      const pgCwd = path.join(pgRoot, "app-cwd");
      const pgDataDir = path.join(pgRoot, "data");
      const pgAgentDir = path.join(pgDataDir, ".pi-agent");
      mkdirSync(pgCwd, { recursive: true, mode: 0o700 });
      mkdirSync(path.join(pgDataDir, "sessions", PG_SESSION_ONE_ID), { recursive: true, mode: 0o700 });
      mkdirSync(pgAgentDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(pgDataDir, "sessions", PG_SESSION_ONE_ID, "history.jsonl"), `{"type":"session","id":"${PG_SESSION_ONE_ID}"}\n`, { mode: 0o600 });
      writeFileSync(path.join(pgAgentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
      const pgCredential = path.join(pgRoot, "creds", "service.auth");
      mkdirSync(path.dirname(pgCredential), { recursive: true, mode: 0o700 });
      writeFileSync(pgCredential, '{"token":"never-touch"}\n', { mode: 0o600 });
      const pgEnv = { ...process.env, AGENT_CWD: pgCwd, DATA_DIR: pgDataDir, PI_AGENT_DIR: pgAgentDir, PI_AUTH_PATH: pgCredential, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: scopedUrl(schema) };
      const pgResult = spawnSync(ownerTransferBin, ["--apply", "--source-ip", SOURCE, "--target-ip", TARGET,
        "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
        "--backup-root", path.join(pgRoot, "backups"), "--age-recipient-file", recipient, "--target-schema", schema],
        { env: pgEnv, encoding: "utf8", timeout: 150_000 });
      if (pgResult.status !== 0) throw new Error(`installed owner-transfer PG apply failed: ${pgResult.stderr}`);
      const pgReport = JSON.parse(pgResult.stdout.trim().split(/\r?\n/).at(-1));
      if (pgReport.status !== "success" || pgReport.dialect !== "PostgreSQL" || pgReport.transfer.sessionsTransferred !== 1) {
        throw new Error("installed owner-transfer PG success report is incomplete");
      }
      if (pgResult.stdout.includes("postgresql://") || pgResult.stdout.includes(pgRoot) || (pgResult.stderr ?? "").includes("postgresql://")) {
        throw new Error("installed owner-transfer PG output leaked the connection URL or fixture paths");
      }
      const owners = await admin.query(`SELECT owner_key FROM ${ident(schema)}.sessions WHERE id = $1`, [PG_SESSION_ONE_ID]);
      if (String(owners.rows[0]?.owner_key) !== TARGET_OWNER) throw new Error("installed owner-transfer PG did not transfer the session owner");
      if (readFileSync(pgCredential, "utf8") !== '{"token":"never-touch"}\n') throw new Error("installed owner-transfer PG touched the credential file");
      console.log("installed npm owner-transfer real-PostgreSQL E2E smoke: ok");
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}