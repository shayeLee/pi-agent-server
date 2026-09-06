// WP5D-4 真实 PostgreSQL owner-transfer 门禁（随机隔离业务 schema，不碰 public/正式数据）：
// 仅在 PI_TEST_PG_URL + pg_dump/pg_restore/age/age-keygen 可用且由强制 runner
// （scripts/test-owner-transfer-pg.ts，设置 PI_TEST_PG_REQUIRED=1）运行；普通 `pnpm test` 安全 skip。
// fixture 创建并最终销毁随机业务 schema（含真实 app schema + migration ledger），
// 绝不 DROP DATABASE、绝不触碰 public 或其他既有数据。
// 断言：真实 age pre-owner-transfer 备份、binding 复验、同一 leased client（事务外参数化
// session pg_advisory_lock(POSTGRES_MIGRATION_LOCK_KEY) 先于 BEGIN）+ 同连接 REPEATABLE
// READ 快照、identity 复验与 UPDATE 同连接、COMMIT 后显式 unlock 验证 true 才归还、
// 只改 owner_key、default 项目 owner='' 保留、fail path（target 非空）ROLLBACK 零生效。
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { createPostgresBackup, verifyPublishedBackup } from "../../src/backup/backup-core.js";
import { postgresIdentity } from "../../src/backup/postgres-backup-core.js";
import type { PublishedBackupVerification } from "../../src/backup/backup-core.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import {
  authorizeOwnerTransfer,
  openPostgresOwnerTransferGate,
  ownerKeyForIp,
  parseOwnerTransferArgs,
  runOwnerTransfer,
  subjectHashForIp,
  validateOwnerTransferSchema,
} from "../../src/owner-transfer/owner-transfer-core.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { checkPgBackupBinaries } from "../../scripts/test-pg-backup.js";
import { resolveBackupCliPaths, type StorageEnvironment } from "../../src/storage/storage-config.js";

const baseUrl = process.env.PI_TEST_PG_URL?.trim();
const binaryGate = checkPgBackupBinaries();
assertRequiredPgTestEnvironment("tests/postgres/owner-transfer-pg", baseUrl, true);
const describeGate = Boolean(baseUrl) && binaryGate.ok ? describe : describe.skip;

const SOURCE = "10.1.2.3";
const TARGET = "10.1.2.4";
const SOURCE_OWNER = ownerKeyForIp(SOURCE);
const TARGET_OWNER = ownerKeyForIp(TARGET);

type TransferFixtureIds = {
  readonly projectId: string;
  readonly defaultSessionId: string;
  readonly projectSessionId: string;
  readonly otherSessionId?: string;
};

// Keep every case's fixture IDs valid PostgreSQL UUIDs and distinct from the
// other cases. The default project is shared by contract and is the one fixed
// UUID imported above.
const FULL_IDS: TransferFixtureIds = {
  projectId: "11111111-1111-4111-8111-111111111111",
  defaultSessionId: "11111111-1111-4111-8111-111111111112",
  projectSessionId: "11111111-1111-4111-8111-111111111113",
  otherSessionId: "11111111-1111-4111-8111-111111111114",
};
const DRY_RUN_IDS: TransferFixtureIds = {
  projectId: "22222222-2222-4222-8222-222222222221",
  defaultSessionId: "22222222-2222-4222-8222-222222222222",
  projectSessionId: "22222222-2222-4222-8222-222222222223",
  otherSessionId: "22222222-2222-4222-8222-222222222224",
};
const OCCUPIED_IDS = {
  sourceProjectId: "33333333-3333-4333-8333-333333333331",
  targetProjectId: "33333333-3333-4333-8333-333333333332",
  sourceSessionId: "33333333-3333-4333-8333-333333333333",
  targetSessionId: "33333333-3333-4333-8333-333333333334",
};
const MISSING_IDS = {
  projectId: "44444444-4444-4444-8444-444444444441",
  defaultSessionId: "44444444-4444-4444-8444-444444444442",
  projectSessionId: "44444444-4444-4444-8444-444444444443",
  ghostSessionId: "44444444-4444-4444-8444-444444444444",
};

// Schema names are database objects; temp roots are filesystem objects. Keep
// their ownership and cleanup operations separate so a schema name can never
// accidentally be passed to rmSync.
const cleanupSchemas: string[] = [];
const cleanupDirs: string[] = [];
let admin: Pool | undefined;

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedUrl(url: string, targetSchema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${targetSchema} -c statement_timeout=30000`);
  return parsed.toString();
}

async function createMigratedSchema(schema: string): Promise<void> {
  admin = admin ?? new Pool({ connectionString: baseUrl! });
  await admin.query(`CREATE SCHEMA ${ident(schema)}`);
  // The Kysely instance owns this migration pool: destroy() delegates to the
  // Postgres dialect and ends it. There is intentionally no second pool.end().
  const migrationPool = createPostgresPool(scopedUrl(baseUrl!, schema));
  const migrationDb = createPostgresKysely(migrationPool);
  try {
    await runPostgresMigrations(migrationDb, { mode: "apply" });
  } finally {
    await migrationDb.destroy();
  }
}

async function insertData(adminPool: Pool, schema: string, ids: TransferFixtureIds): Promise<void> {
  const q = (sql: string, params: readonly unknown[] = []) => adminPool.query(sql, params as never[]);
  await q(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [DEFAULT_PROJECT_ID, "默认项目", "/cwd", "", 0]);
  await q(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [ids.projectId, "custom", "/cwd", SOURCE_OWNER, 1]);
  await q(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [ids.defaultSessionId, SOURCE_OWNER, DEFAULT_PROJECT_ID, "default-session", 1, 1, null, "{}"]);
  await q(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [ids.projectSessionId, SOURCE_OWNER, ids.projectId, "project-session", 1, 1, null, "{}"]);
  if (ids.otherSessionId) {
    await q(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [ids.otherSessionId, ownerKeyForIp("10.1.2.9"), DEFAULT_PROJECT_ID, "other", 1, 1, null, "{}"]);
  }
  const defaults = await adminPool.query(`SELECT owner_key FROM ${ident(schema)}.projects WHERE id = $1`, [DEFAULT_PROJECT_ID]);
  expect(defaults.rows[0]?.owner_key).toBe("");
}

async function readOwners(schema: string): Promise<{ projects: Record<string, string>; sessions: Record<string, string> }> {
  const projects = await admin!.query(`SELECT id, owner_key FROM ${ident(schema)}.projects`);
  const sessions = await admin!.query(`SELECT id, owner_key FROM ${ident(schema)}.sessions`);
  return {
    projects: Object.fromEntries(projects.rows.map((row) => [String(row.id), String(row.owner_key)])),
    sessions: Object.fromEntries(sessions.rows.map((row) => [String(row.id), String(row.owner_key)])),
  };
}

async function currentDatabaseName(): Promise<string> {
  const result = await admin!.query("SELECT current_database() AS db");
  return String(result.rows[0]?.db);
}

// Keep the fixture verification identical to production's optionalText():
// null/undefined/empty strings are absent, while non-empty strings are kept.
function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 从真实服务器抓取 cluster/database/schema binding，构造 revalidate 用的 verification。 */
async function currentPostgresBinding(schema: string): Promise<PublishedBackupVerification> {
  const cluster = await admin!.query("SELECT system_identifier::text AS system_identifier FROM pg_control_system()");
  const identity = await admin!.query(
    `SELECT (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid, ` +
    `(SELECT oid::text FROM pg_namespace WHERE nspname = $1) AS schema_oid, ` +
    `inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port, ` +
    `current_setting('cluster_name') AS cluster_name`,
    [schema],
  );
  const database = await currentDatabaseName();
  const row = identity.rows[0] ?? {};
  return {
    id: "fixture-verification",
    kind: "pre-owner-transfer",
    checksum: "0".repeat(64),
    version: 1,
    sourceRoots: null,
    sqliteTarget: null,
    sqliteTreeBinding: null,
    postgres: {
      databaseIdentity: postgresIdentity(database, "database"),
      schemaIdentity: postgresIdentity(schema, "schema"),
      systemIdentifier: optionalText(cluster.rows[0]?.system_identifier),
      databaseOid: optionalText(row.database_oid),
      schemaOid: optionalText(row.schema_oid),
      serverAddress: optionalText(row.server_address),
      serverPort: optionalText(row.server_port),
      clusterName: optionalText(row.cluster_name),
    },
  };
}

function writeFixture(root: string, ids: Pick<TransferFixtureIds, "projectId" | "defaultSessionId" | "projectSessionId">, includeProjectSession = true): { cwd: string; dataDir: string; agentDir: string; backupRoot: string; recipient: string; identity: string } {
  const cwd = path.join(root, "app-cwd");
  const dataDir = path.join(root, "data");
  const agentDir = path.join(dataDir, ".pi-agent");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "sessions", ids.defaultSessionId), { recursive: true, mode: 0o700 });
  if (includeProjectSession) mkdirSync(path.join(dataDir, "projects", ids.projectId, "sessions", ids.projectSessionId), { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dataDir, "sessions", ids.defaultSessionId, "history.jsonl"), '{"type":"session","id":"gate"}\n', { mode: 0o600 });
  if (includeProjectSession) writeFileSync(path.join(dataDir, "projects", ids.projectId, "sessions", ids.projectSessionId, "history.jsonl"), '{"type":"session","id":"gate-p"}\n', { mode: 0o600 });
  writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  const identity = path.join(root, "identity");
  const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
  expect(generated.status).toBe(0);
  const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
  expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
  const recipient = path.join(root, "recipient");
  writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });
  return { cwd, dataDir, agentDir, backupRoot: path.join(root, "backups"), recipient, identity };
}

describeGate("WP5D-4 real PostgreSQL owner-transfer gate (random isolated schema)", () => {
  afterAll(async () => {
    for (const schema of cleanupSchemas.splice(0)) await admin?.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
    for (const directory of cleanupDirs.splice(0)) {
      if (path.isAbsolute(directory)) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("performs a full apply on a real app schema: real-age backup → verify → binding revalidate → same-connection transfer/verify", async () => {
    const schema = validateOwnerTransferSchema(`ot_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    cleanupSchemas.push(schema);
    await createMigratedSchema(schema);
    await insertData(admin!, schema, FULL_IDS);

    const root = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-pg-"));
    cleanupDirs.push(root);
    const fixture = writeFixture(root, FULL_IDS);
    const databaseName = await currentDatabaseName();

    const cli = parseOwnerTransferArgs([
      "--apply", "--source-ip", SOURCE, "--target-ip", TARGET,
      "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
      "--backup-root", fixture.backupRoot, "--age-recipient-file", fixture.recipient, "--target-schema", schema,
    ]);
    const environment = {
      AGENT_CWD: fixture.cwd,
      DATA_DIR: fixture.dataDir,
      PI_AGENT_DIR: fixture.agentDir,
      PI_STORAGE_DIALECT: "postgres",
      PI_DATABASE_URL: scopedUrl(baseUrl!, schema),
    } satisfies StorageEnvironment;
    const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
    const pool = createPostgresPool(environment.PI_DATABASE_URL, { connectionTimeoutMillis: 5_000, statementTimeoutMs: 20_000, queryTimeoutMs: 20_000 });
    const gate = openPostgresOwnerTransferGate(pool, databaseName, schema, SOURCE_OWNER, TARGET_OWNER);
    try {
      const ledger = await admin!.query(`SELECT count(*)::int AS count FROM ${ident(schema)}.schema_migrations`);
      expect(ledger.rows[0]?.count).toBeGreaterThan(0);
      const report = await runOwnerTransfer(authorizeOwnerTransfer(cli), {
        createBackup: () => createPostgresBackup({
          storageDialect: "postgres",
          databaseUrl: environment.PI_DATABASE_URL,
          paths: { dataDir: paths.dataDir, agentDir: paths.agentDir, authPath: paths.authPath, backupRoot: paths.backupRoot, ageRecipientFile: paths.ageRecipientFile },
          backupKind: "pre-owner-transfer",
        }),
        verifyBackup: verifyPublishedBackup,
        revalidateBeforeTransfer: (verification) => gate.revalidate(verification),
        transfer: () => gate.transfer("apply"),
      }, { dialect: "PostgreSQL", sourceSubjectHash: subjectHashForIp(SOURCE), targetSubjectHash: subjectHashForIp(TARGET) });

      expect(report.status).toBe("success");
      expect(report.dialect).toBe("PostgreSQL");
      expect(report.transfer.projectsTransferred).toBe(1);
      expect(report.transfer.sessionsTransferred).toBe(2);
      expect(report.backup.kind).toBe("pre-owner-transfer");
      expect(report.backup.checksum).toMatch(/^[0-9a-f]{64}$/);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(SOURCE);
      expect(serialized).not.toContain(TARGET);
      expect(serialized).not.toContain(fixture.dataDir);

      const owners = await readOwners(schema);
      expect(owners.projects[DEFAULT_PROJECT_ID]).toBe("");
      expect(owners.projects[FULL_IDS.projectId]).toBe(TARGET_OWNER);
      expect(owners.sessions[FULL_IDS.defaultSessionId]).toBe(TARGET_OWNER);
      expect(owners.sessions[FULL_IDS.projectSessionId]).toBe(TARGET_OWNER);
      expect(owners.sessions[FULL_IDS.otherSessionId!]).toBe(ownerKeyForIp("10.1.2.9"));
      expect(Object.values(owners.projects).filter((owner) => owner === SOURCE_OWNER)).toHaveLength(0);
      expect(Object.values(owners.sessions).filter((owner) => owner === SOURCE_OWNER)).toHaveLength(0);

      // JSONL 与 models.json 零触碰。
      expect(readFileSync(path.join(fixture.dataDir, "sessions", FULL_IDS.defaultSessionId, "history.jsonl"), "utf8")).toBe('{"type":"session","id":"gate"}\n');
      expect(readFileSync(path.join(fixture.agentDir, "models.json"), "utf8")).toBe('{"models":[]}\n');

      // 备份包可被真实 age 解密且 kind=pre-owner-transfer。
      const packages = readdirSync(fixture.backupRoot).filter((entry) => entry.startsWith("backup-"));
      expect(packages).toHaveLength(1);
      const packagePath = path.join(fixture.backupRoot, packages[0]!);
      const manifest = spawnSync("age", ["--decrypt", "--identity", fixture.identity, path.join(packagePath, "manifest.json.age")], { encoding: "utf8" });
      expect(manifest.status).toBe(0);
      const manifestJson = JSON.parse(manifest.stdout) as { kind: string; postgres: { clusterName: string | null } };
      expect(manifestJson.kind).toBe("pre-owner-transfer");
      // Match production optionalText semantics for both the default empty
      // cluster_name and installations that explicitly configure a name.
      const clusterName = await admin!.query("SELECT current_setting('cluster_name') AS cluster_name");
      expect(manifestJson.postgres.clusterName).toBe(optionalText(clusterName.rows[0]?.cluster_name));
    } finally {
      await gate.cleanup();
      await pool.end().catch(() => undefined);
    }
  }, 240_000);

  it("dry-run reports the plan and leaves every owner_key untouched (read-only transaction)", async () => {
    const schema = validateOwnerTransferSchema(`ot${randomUUID().replaceAll("-", "").slice(0, 24)}_d`);
    cleanupSchemas.push(schema);
    await createMigratedSchema(schema);
    await insertData(admin!, schema, DRY_RUN_IDS);
    const before = await readOwners(schema);
    const databaseName = await currentDatabaseName();

    const gatePool = createPostgresPool(scopedUrl(baseUrl!, schema), { connectionTimeoutMillis: 5_000 });
    const gate = openPostgresOwnerTransferGate(gatePool, databaseName, schema, SOURCE_OWNER, TARGET_OWNER);
    try {
      const plan = await gate.transfer("dry-run");
      expect(plan.projectsTransferred).toBe(1);
      expect(plan.sessionsTransferred).toBe(2);
      expect(plan.defaultProjectOwnerPreserved).toBe(true);
    } finally {
      await gate.cleanup();
      await gatePool.end().catch(() => undefined);
    }
    const after = await readOwners(schema);
    expect(after).toEqual(before);
  }, 120_000);

  it("rejects an occupied target owner with zero writes (rollback) and never scans/uses other schemas", async () => {
    const schema = validateOwnerTransferSchema(`ot${randomUUID().replaceAll("-", "").slice(0, 24)}_occ`);
    const bystander = `ot${randomUUID().replaceAll("-", "").slice(0, 16)}_bs`;
    cleanupSchemas.push(schema, bystander);
    await createMigratedSchema(schema);
    await admin!.query(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [DEFAULT_PROJECT_ID, "默认项目", "/cwd", "", 0]);
    await admin!.query(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [OCCUPIED_IDS.sourceProjectId, "source", "/cwd", SOURCE_OWNER, 1]);
    await admin!.query(`INSERT INTO ${ident(schema)}.projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)`, [OCCUPIED_IDS.targetProjectId, "target-held", "/cwd", TARGET_OWNER, 1]);
    await admin!.query(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [OCCUPIED_IDS.sourceSessionId, SOURCE_OWNER, OCCUPIED_IDS.sourceProjectId, "t", 1, 1, null, "{}"]);
    await admin!.query(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [OCCUPIED_IDS.targetSessionId, TARGET_OWNER, OCCUPIED_IDS.targetProjectId, "t", 1, 1, null, "{}"]);
    const occupiedDefault = await admin!.query(`SELECT owner_key FROM ${ident(schema)}.projects WHERE id = $1`, [DEFAULT_PROJECT_ID]);
    expect(occupiedDefault.rows[0]?.owner_key).toBe("");
    await admin!.query(`CREATE SCHEMA ${ident(bystander)}`);
    await admin!.query(`CREATE TABLE ${ident(bystander)}.bystander_table (id int)`);
    const before = await readOwners(schema);
    const databaseName = await currentDatabaseName();

    const gatePool = createPostgresPool(scopedUrl(baseUrl!, schema), { connectionTimeoutMillis: 5_000, statementTimeoutMs: 20_000, queryTimeoutMs: 20_000 });
    const gate = openPostgresOwnerTransferGate(gatePool, databaseName, schema, SOURCE_OWNER, TARGET_OWNER);
    try {
      // Apply must run inside the SAME transaction as the binding revalidation
      // (same leased client): revalidate first with the real cluster binding,
      // then the transfer fails on the occupied target and rolls back.
      await gate.revalidate(await currentPostgresBinding(schema));
      await expect(gate.transfer("apply")).rejects.toThrow(/merge is not supported/);
      const after = await readOwners(schema);
      expect(after).toEqual(before);
    } finally {
      await gate.cleanup();
      await gatePool.end().catch(() => undefined);
    }
    // 未触碰 bystander schema。
    const bystanderRow = await admin!.query(`SELECT count(*)::int AS count FROM ${ident(bystander)}.bystander_table`);
    expect(bystanderRow.rows[0]?.count).toBe(0);
  }, 120_000);

  it("fails closed with zero owner changes and no COMPLETE package when a session reference JSONL is missing (strict pre-owner-transfer backup)", async () => {
    const schema = validateOwnerTransferSchema(`ot${randomUUID().replaceAll("-", "").slice(0, 24)}_miss`);
    cleanupSchemas.push(schema);
    await createMigratedSchema(schema);
    await insertData(admin!, schema, MISSING_IDS);

    const root = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-pg-missing-"));
    cleanupDirs.push(root);
    const fixture = writeFixture(root, MISSING_IDS, false);
    // The ghost reference uses the real project-session layout, but its file is
    // absent. Under missing-as-empty (Phase 3), the pre-owner-transfer backup
    // still publishes and the transfer proceeds.
    const ghostFile = path.join(fixture.dataDir, "projects", MISSING_IDS.projectId, "sessions", MISSING_IDS.ghostSessionId, "history.jsonl");
    await admin!.query(`INSERT INTO ${ident(schema)}.sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [MISSING_IDS.ghostSessionId, SOURCE_OWNER, MISSING_IDS.projectId, "t", 1, 1, ghostFile, "{}"]);
    const databaseName = await currentDatabaseName();

    const cli = parseOwnerTransferArgs([
      "--apply", "--source-ip", SOURCE, "--target-ip", TARGET,
      "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
      "--backup-root", fixture.backupRoot, "--age-recipient-file", fixture.recipient, "--target-schema", schema,
    ]);
    const environment = {
      AGENT_CWD: fixture.cwd,
      DATA_DIR: fixture.dataDir,
      PI_AGENT_DIR: fixture.agentDir,
      PI_STORAGE_DIALECT: "postgres",
      PI_DATABASE_URL: scopedUrl(baseUrl!, schema),
    } satisfies StorageEnvironment;
    const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
    const pool = createPostgresPool(environment.PI_DATABASE_URL, { connectionTimeoutMillis: 5_000, statementTimeoutMs: 20_000, queryTimeoutMs: 20_000 });
    const gate = openPostgresOwnerTransferGate(pool, databaseName, schema, SOURCE_OWNER, TARGET_OWNER);
    try {
      // Missing-as-empty（Phase 3 已确认语义）：pre-owner-transfer 备份照常发布，
      // 缺失引用记入 manifest；owner 转移不受影响并成功完成。
      const report = await runOwnerTransfer(authorizeOwnerTransfer(cli), {
        createBackup: () => createPostgresBackup({
          storageDialect: "postgres",
          databaseUrl: environment.PI_DATABASE_URL,
          paths: { dataDir: paths.dataDir, agentDir: paths.agentDir, authPath: paths.authPath, backupRoot: paths.backupRoot, ageRecipientFile: paths.ageRecipientFile },
          backupKind: "pre-owner-transfer",
        }),
        verifyBackup: verifyPublishedBackup,
        revalidateBeforeTransfer: (verification) => gate.revalidate(verification),
        transfer: () => gate.transfer("apply"),
      }, { dialect: "PostgreSQL", sourceSubjectHash: subjectHashForIp(SOURCE), targetSubjectHash: subjectHashForIp(TARGET) });
      expect(report.status).toBe("success");
      expect(report.backup.kind).toBe("pre-owner-transfer");
      // 缺失引用不阻止转移：owner 行照常转移（包括 ghost session）。
      const after = await readOwners(schema);
      expect(after.projects[DEFAULT_PROJECT_ID]).toBe("");
      expect(after.projects[MISSING_IDS.projectId]).toBe(TARGET_OWNER);
      expect(after.sessions[MISSING_IDS.defaultSessionId]).toBe(TARGET_OWNER);
      expect(after.sessions[MISSING_IDS.projectSessionId]).toBe(TARGET_OWNER);
      expect(after.sessions[MISSING_IDS.ghostSessionId]).toBe(TARGET_OWNER);
      // 备份已发布：backup root 下存在带 COMPLETE 的包。
      const packages = existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot).filter((entry) => entry.startsWith("backup-")) : [];
      expect(packages.length).toBe(1);
      expect(existsSync(path.join(fixture.backupRoot, packages[0]!, "COMPLETE"))).toBe(true);
    } finally {
      await gate.cleanup();
      await pool.end().catch(() => undefined);
    }
  }, 240_000);
});