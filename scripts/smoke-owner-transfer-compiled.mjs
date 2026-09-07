// WP5D-4 compiled owner-transfer CLI smoke: runs dist-owner-transfer/scripts/owner-transfer.js
// against isolated temporary SQLite fixtures (real age binaries required) and, when
// PI_TEST_PG_URL + pg binaries are set, a real random isolated PG schema. Never touches
// any real user data.
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";

checkDistHygiene("dist-owner-transfer");

const ownerTransferBin = path.resolve("dist-owner-transfer/scripts/owner-transfer.js");
if (!existsSync(ownerTransferBin)) throw new Error("compiled owner-transfer CLI is missing (build:owner-transfer must run first)");
const { initializeDatabase } = await import(pathToFileURL(path.resolve("dist-owner-transfer/src/storage/bootstrap.js")));
const { createPostgresKysely, createPostgresPool } = await import(pathToFileURL(path.resolve("dist-owner-transfer/src/storage/postgres-bootstrap.js")));
const { runPostgresMigrations } = await import(pathToFileURL(path.resolve("dist-owner-transfer/src/storage/migration-engine.js")));

const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const SOURCE = "10.1.2.3";
const TARGET = "10.1.2.4";
const SOURCE_OWNER = `ip:${SOURCE}`;
const TARGET_OWNER = `ip:${TARGET}`;

const pgUrl = process.env.PI_TEST_PG_URL?.trim() ?? "";
const pgBinaries = ["pg_dump", "pg_restore", "age", "age-keygen"]
  .filter((binary) => spawnSync(binary, ["--version"], { stdio: "ignore" }).status !== 0);
const runRealPg = pgUrl !== "" && pgBinaries.length === 0;

const directory = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-build-smoke-"));
process.env.PI_BACKUP_STAGING_ROOT = mkdtempSync(path.join(tmpdir(), "pi-smoke-staging-"));
const results = [];
try {
  const ageKey = () => {
    const identity = path.join(directory, "identity");
    const recipient = path.join(directory, "recipient.txt");
    if (!existsSync(identity)) {
      const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
      if (generated.status !== 0) throw new Error("age-keygen unavailable; compiled owner-transfer smoke cannot run");
      const extracted = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" });
      const publicKey = extracted.stdout.trim();
      if (!/^age1[0-9a-z]+$/.test(publicKey)) throw new Error("age recipient extraction failed");
      writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });
    }
    return { identity, recipient };
  };

  const createFixture = async (tag) => {
    const root = path.join(directory, `fixture-${tag}`);
    const cwd = path.join(root, "app-cwd");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(dataDir, ".pi-agent");
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
    db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s3", "ip:10.1.2.9", DEFAULT_PROJECT_ID, "other", 1, 1, null, "{}");
    db.close();
    return { root, cwd, dataDir, agentDir, dbPath, backupRoot: path.join(root, "backups") };
  };

  const env = (fixture, extra = {}) => ({ ...process.env, AGENT_CWD: fixture.cwd, DATA_DIR: fixture.dataDir, DB_PATH: fixture.dbPath, PI_AGENT_DIR: fixture.agentDir, PI_AUTH_PATH: path.join(fixture.dataDir, "auth.json"), ...extra });
  const args = (fixture, recipient, mode = "--apply", overrides = []) => [
    mode, "--source-ip", SOURCE, "--target-ip", TARGET,
    "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
    "--backup-root", fixture.backupRoot, "--age-recipient-file", recipient,
    ...overrides,
  ];
  const readOwners = (dbPath) => {
    const check = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
    try {
      const projects = Object.fromEntries((check.prepare("SELECT id, owner_key FROM projects").all()).map((row) => [String(row.id), String(row.owner_key)]));
      const sessions = Object.fromEntries((check.prepare("SELECT id, owner_key FROM sessions").all()).map((row) => [String(row.id), String(row.owner_key)]));
      return { projects, sessions };
    } finally { check.close(); }
  };

  ageKey();
  const { recipient } = ageKey();

  // 1. Wrong confirmation token: non-zero exit, zero writes, no backup package.
  const wrongFixture = await createFixture("wrong");
  const dbBefore = readFileSync(wrongFixture.dbPath);
  const wrong = spawnSync(process.execPath, [ownerTransferBin, ...args(wrongFixture, recipient, "--apply", ["--confirm-transfer", "transfer_ip_ownership"])], { env: env(wrongFixture), encoding: "utf8" });
  if (wrong.status === 0) throw new Error("compiled owner-transfer accepted a wrong confirmation token");
  if (readFileSync(wrongFixture.dbPath).toString() !== dbBefore.toString()) throw new Error("compiled owner-transfer wrote data without a valid confirmation");
  if (existsSync(wrongFixture.backupRoot)) throw new Error("compiled owner-transfer published a backup without a valid confirmation");
  results.push("wrong-confirmation");

  // 2. Dry-run: zero writes (DB/WAL/SHM byte-identical), plan carries subject hashes only.
  const dryFixture = await createFixture("dry");
  const dryTree = () => ["", "-wal", "-shm"].map((suffix) => `${dryFixture.dbPath}${suffix}`).map((file) => existsSync(file) ? readFileSync(file).toString("hex") : null).join("|");
  const dryBefore = dryTree();
  const dry = spawnSync(process.execPath, [ownerTransferBin, ...args(dryFixture, recipient, "--dry-run")], { env: env(dryFixture), encoding: "utf8" });
  if (dry.status !== 0) throw new Error("compiled owner-transfer dry-run failed");
  const dryPlan = JSON.parse(dry.stdout.trim().split(/\r?\n/).at(-1));
  if (dryPlan.status !== "planned" || dryPlan.mode !== "dry-run" || dryPlan.dialect !== "SQLite" ||
    dryPlan.planned.projectsTransferred !== 1 || dryPlan.planned.sessionsTransferred !== 2) {
    throw new Error("compiled owner-transfer dry-run plan is incomplete");
  }
  if (!/^[0-9a-f]{16}$/.test(dryPlan.sourceSubjectHash) || !/^[0-9a-f]{16}$/.test(dryPlan.targetSubjectHash)) throw new Error("compiled owner-transfer dry-run did not emit subject hashes");
  if (JSON.stringify(dryPlan).includes(SOURCE) || JSON.stringify(dryPlan).includes(TARGET) || JSON.stringify(dryPlan).includes(dryFixture.dataDir)) {
    throw new Error("compiled owner-transfer dry-run leaked IP/dataDir values");
  }
  if (dryTree() !== dryBefore || existsSync(dryFixture.backupRoot)) throw new Error("compiled owner-transfer dry-run wrote to the target");
  results.push("dry-run");

  // 3. Full apply: only owner_key changes, default project owner '' stays, JSONL/models/credential untouched, package published.
  const fixture = await createFixture("apply");
  const apply = spawnSync(process.execPath, [ownerTransferBin, ...args(fixture, recipient)], { env: env(fixture), encoding: "utf8" });
  if (apply.status !== 0) throw new Error(`compiled owner-transfer apply failed: ${apply.stderr}`);
  const report = JSON.parse(apply.stdout.trim().split(/\r?\n/).at(-1));
  if (report.status !== "success" || report.dialect !== "SQLite" || report.backup.kind !== "pre-owner-transfer" ||
    report.transfer.projectsTransferred !== 1 || report.transfer.sessionsTransferred !== 2 || report.transfer.defaultProjectOwnerPreserved !== true) {
    throw new Error("compiled owner-transfer success report is incomplete");
  }
  if (!/^[0-9a-f]{16}$/.test(report.sourceSubjectHash) || !/^[0-9a-f]{16}$/.test(report.targetSubjectHash)) throw new Error("compiled owner-transfer report has no subject hashes");
  if (JSON.stringify(report).includes(SOURCE) || JSON.stringify(report).includes(TARGET) || JSON.stringify(report).includes(fixture.dataDir) || JSON.stringify(report).includes(fixture.dbPath)) {
    throw new Error("compiled owner-transfer report leaked IP/path values");
  }
  const owners = readOwners(fixture.dbPath);
  if (owners.projects[DEFAULT_PROJECT_ID] !== "" || owners.projects.p1 !== TARGET_OWNER ||
    owners.sessions.s1 !== TARGET_OWNER || owners.sessions.s2 !== TARGET_OWNER || owners.sessions.s3 !== "ip:10.1.2.9") {
    throw new Error("compiled owner-transfer did not transfer the exact owner rows");
  }
  if (readFileSync(path.join(fixture.agentDir, "models.json"), "utf8") !== '{"models":[]}\n') throw new Error("compiled owner-transfer deleted the whitelisted service config");
  if (readFileSync(path.join(fixture.dataDir, "auth.json"), "utf8") !== '{"token":"never-touch"}\n') throw new Error("compiled owner-transfer touched the credential file");
  if (!existsSync(fixture.backupRoot)) throw new Error("compiled owner-transfer did not publish a backup");
  const packages = readdirSync(fixture.backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (packages.length !== 1 || !existsSync(path.join(fixture.backupRoot, packages[0], "COMPLETE"))) throw new Error("compiled owner-transfer did not publish a COMPLETE pre-owner-transfer package");
  results.push("apply");

  // 4. Fail path: occupied target owner → non-zero exit, rollback (state byte-identical).
  const occFixture = await createFixture("occupied");
  {
    const occDb = new DatabaseSync(occFixture.dbPath);
    occDb.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run("p2", "target-held", "/cwd", TARGET_OWNER, 1);
    occDb.close();
  }
  const occBefore = readFileSync(occFixture.dbPath).toString();
  const occupied = spawnSync(process.execPath, [ownerTransferBin, ...args(occFixture, recipient)], { env: env(occFixture), encoding: "utf8" });
  if (occupied.status === 0) throw new Error("compiled owner-transfer merged into an occupied target owner");
  if (readFileSync(occFixture.dbPath).toString() !== occBefore) throw new Error("compiled owner-transfer rolled back but the DB changed");
  // The pre-transfer recovery backup is intentionally retained; the transfer rolled back with zero writes.
  const occPackages = existsSync(occFixture.backupRoot) ? readdirSync(occFixture.backupRoot) : [];
  if (occPackages.length === 0 || !occPackages.every((entry) => entry.startsWith("backup-"))) throw new Error("compiled owner-transfer failed to retain the pre-transfer recovery backup");
  results.push("occupied-rollback");

  // 5. Missing session-reference JSONL (missing-as-empty, Phase 3): the
  // pre-owner-transfer backup still publishes (the reference is recorded in
  // the encrypted manifest) and the transfer performs the owner changes.
  const missFixture = await createFixture("missing-jsonl");
  {
    const missDb = new DatabaseSync(missFixture.dbPath);
    missDb.prepare("UPDATE sessions SET conversation_ref = ? WHERE id = ?").run(path.join(missFixture.dataDir, "sessions", "s1", "ghost.jsonl"), "s1");
    missDb.close();
  }
  const missing = spawnSync(process.execPath, [ownerTransferBin, ...args(missFixture, recipient)], { env: env(missFixture), encoding: "utf8" });
  if (missing.status !== 0) throw new Error(`compiled owner-transfer failed with a missing session reference (missing-as-empty): ${missing.stderr}`);
  const missReport = JSON.parse(missing.stdout.trim().split(/\r?\n/).at(-1));
  if (missReport.status !== "success" || missReport.dialect !== "SQLite" || missReport.backup.kind !== "pre-owner-transfer" ||
    missReport.transfer.projectsTransferred !== 1 || missReport.transfer.sessionsTransferred !== 2) {
    throw new Error("compiled owner-transfer missing-as-empty success report is incomplete");
  }
  if ((missing.stderr ?? "").includes(missFixture.dataDir) || (missing.stderr ?? "").includes(path.join(missFixture.dataDir, "sessions", "s1", "ghost.jsonl"))) {
    throw new Error("compiled owner-transfer missing-as-empty path leaked the data directory");
  }
  const missOwners = readOwners(missFixture.dbPath);
  if (missOwners.projects[DEFAULT_PROJECT_ID] !== "" || missOwners.projects.p1 !== TARGET_OWNER ||
    missOwners.sessions.s1 !== TARGET_OWNER || missOwners.sessions.s2 !== TARGET_OWNER) {
    throw new Error("compiled owner-transfer did not transfer exact owner rows with a missing reference");
  }
  const missPackages = readdirSync(missFixture.backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (missPackages.length !== 1 || !existsSync(path.join(missFixture.backupRoot, missPackages[0], "COMPLETE"))) {
    throw new Error("compiled owner-transfer did not publish a COMPLETE package despite the missing reference");
  }
  results.push("missing-jsonl");

  console.log(`compiled owner-transfer E2E and safe-failure smokes: ok (${results.join(", ")})`);

  // 6. Real PostgreSQL E2E（随机隔离业务 schema；无 URL/二进制时打印 skip）。
  if (!runRealPg) {
    console.log(`compiled owner-transfer PG E2E: skipped (${pgUrl === "" ? "PI_TEST_PG_URL not set" : `missing binaries: ${pgBinaries.join(", ")}`})`);
  } else {
    const PG_CUSTOM_PROJECT_ID = "1a2b3c4d-5e6f-4789-8abc-def012345678";
    const PG_SESSION_ONE_ID = "2b3c4d5e-6f70-489a-8bcd-ef0123456789";
    const PG_SESSION_TWO_ID = "3c4d5e6f-7081-49ab-8cde-f0123456789a";
    const { Client } = await import("pg");
    const schema = `ot_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const bystander = `ot${randomUUID().replaceAll("-", "").slice(0, 16)}_bs`;
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
      await admin.query(`CREATE SCHEMA ${ident(bystander)}`);
      // Build the canonical schema (all managed tables + schema_migrations ledger)
      // in the scoped non-public schema with the compiled migration engine. The
      // prior manual DDL was a legacy shape lacking schema_migrations, which the
      // pre-owner-transfer backup ledger requires; the production backup ledger
      // rule is unchanged.
      {
        const seedPool = createPostgresPool(scopedUrl(schema));
        const seedDb = createPostgresKysely(seedPool);
        try {
          await runPostgresMigrations(seedDb, { mode: "apply" });
        } finally {
          await seedDb.destroy();
        }
      }
      await admin.query(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [DEFAULT_PROJECT_ID, "默认项目", "/cwd", "", 0]);
      await admin.query(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [PG_CUSTOM_PROJECT_ID, "custom", "/cwd", SOURCE_OWNER, 1]);
      await admin.query(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [PG_SESSION_ONE_ID, SOURCE_OWNER, DEFAULT_PROJECT_ID, "t", 1, 1, null, "{}"]);
      await admin.query(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [PG_SESSION_TWO_ID, SOURCE_OWNER, PG_CUSTOM_PROJECT_ID, "t", 1, 1, null, "{}"]);
      await admin.query(`CREATE TABLE ${ident(bystander)}.bystander_table (id int)`);
      const pgRoot = path.join(directory, "pg-fixture");
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
      const pgArgs = ["--apply", "--source-ip", SOURCE, "--target-ip", TARGET,
        "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
        "--backup-root", path.join(pgRoot, "backups"), "--age-recipient-file", recipient, "--target-schema", schema];
      const pgResult = spawnSync(process.execPath, [ownerTransferBin, ...pgArgs], { env: pgEnv, encoding: "utf8", timeout: 150_000 });
      if (pgResult.status !== 0) throw new Error(`compiled owner-transfer PG apply failed: ${pgResult.stderr}`);
      const pgReport = JSON.parse(pgResult.stdout.trim().split(/\r?\n/).at(-1));
      if (pgReport.status !== "success" || pgReport.dialect !== "PostgreSQL" || pgReport.transfer.projectsTransferred !== 1 || pgReport.transfer.sessionsTransferred !== 2) {
        throw new Error("compiled owner-transfer PG success report is incomplete");
      }
      if (pgResult.stdout.includes("postgresql://") || pgResult.stdout.includes(pgRoot) || (pgResult.stderr ?? "").includes("postgresql://")) {
        throw new Error("compiled owner-transfer PG output leaked the connection URL or fixture paths");
      }
      const owners = await (async () => {
        const projects = await admin.query(`SELECT id, owner_key FROM ${ident(schema)}.projects`);
        const sessions = await admin.query(`SELECT id, owner_key FROM ${ident(schema)}.sessions`);
        return {
          projects: Object.fromEntries(projects.rows.map((row) => [String(row.id), String(row.owner_key)])),
          sessions: Object.fromEntries(sessions.rows.map((row) => [String(row.id), String(row.owner_key)])),
        };
      })();
      if (owners.projects[DEFAULT_PROJECT_ID] !== "" || owners.projects[PG_CUSTOM_PROJECT_ID] !== TARGET_OWNER || owners.sessions[PG_SESSION_ONE_ID] !== TARGET_OWNER || owners.sessions[PG_SESSION_TWO_ID] !== TARGET_OWNER) {
        throw new Error("compiled owner-transfer PG did not transfer the exact owner rows");
      }
      if (readFileSync(pgCredential, "utf8") !== '{"token":"never-touch"}\n') throw new Error("compiled owner-transfer PG touched the credential file");
      if (readFileSync(path.join(pgAgentDir, "models.json"), "utf8") !== '{"models":[]}\n') throw new Error("compiled owner-transfer PG deleted the whitelisted service config");
      const bystanderCount = await admin.query(`SELECT count(*)::int AS count FROM ${ident(bystander)}.bystander_table`);
      if (bystanderCount.rows[0].count !== 0) throw new Error("compiled owner-transfer PG scanned/touched a bystander schema");
      results.push("pg-apply");
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${ident(bystander)} CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}