// WP2A 受控 cutover 核心（SQLite 路径，隔离临时目录 + 注入 fake age，零真实删除面）。
// 覆盖：dry-run 零写入、备份失败不 reset、错误确认不 reset、成功 cutover 的 DB/WAL/JSONL reset
// 与 models.json 保留/auth 排除、migration 失败保留备份且无成功输出、legacy 备份元数据、
// target 安全拒绝（memory/symlink/hardlink/relative/overlap）。
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup, verifyPublishedBackup, type AgeAdapter, type PublishedBackupVerification } from "../../src/backup/backup-core.js";
import { postgresIdentity } from "../../src/backup/postgres-backup-core.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import {
  applySqliteMigrationsAfterReset,
  authorizeCutover,
  CUTOVER_CONFIRM_TOKEN,
  CUTOVER_SCHEMA_PREFIX,
  openPostgresDedicatedResetGate,
  parseCutoverArgs,
  revalidatePostgresCutoverTarget,
  revalidateSqliteCutoverTarget,
  resetPostgresSchemaForCutover,
  resetSqliteForCutover,
  resolvePostgresCutoverTarget,
  resolveSqliteCutoverTarget,
  runControlledCutover,
  validateCutoverTargetSchema,
} from "../../src/cutover/cutover-core.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const HEAD_VERSION = migrationDefinitions.at(-1)!.version;

interface Fixture {
  root: string; cwd: string; dataDir: string; agentDir: string; dbPath: string;
  backupRoot: string; recipient: string; sessionFile: string;
}

/** legacy RC 形态：bootstrap 建 managed 表、无 schema_migrations ledger、含会话 JSONL 与配置。 */
async function createLegacyFixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-cutover-test-"));
  cleanups.push(root);
  const cwd = path.join(root, "app-cwd");
  const dataDir = path.join(root, "data");
  const agentDir = path.join(dataDir, ".pi-agent");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/legacy"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"legacy","timestamp":1}}\n', { mode: 0o600 });
  // models.json = 必须保留的白名单服务配置；auth.json = 永不删除也永不备份的凭证文件
  // （dataDir 根与 sessions 根内各一份：前者验证 reset 保留，后者验证备份白名单排除）。
  writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, "auth.json"), '{"token":"never-touch"}\n', { mode: 0o600 });
  writeFileSync(path.join(dataDir, "sessions", "auth.json"), '{"token":"excluded"}\n', { mode: 0o600 });
  writeFileSync(path.join(cwd, "unrelated.txt"), "cwd must survive cutover\n", { mode: 0o600 });
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  await initializeDatabase(db);
  db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)").run("p1", "legacy", "/legacy", "owner", 1);
  db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("s1", "owner", "p1", "legacy", 1, 1, sessionFile, "{}");
  db.close();
  return { root, cwd, dataDir, agentDir, dbPath, backupRoot: path.join(root, "backups"), recipient: path.join(root, "recipient.txt"), sessionFile };
}

function fakeAge(): AgeAdapter {
  return { encrypt(input) { return Buffer.from(`FAKE-AGE\n${input.toString("base64")}`, "utf8"); } };
}

function failingAge(): AgeAdapter {
  return { async encrypt() { throw new Error("injected age failure"); } };
}

type TestEnvironment = Record<string, string>;

function environment(fixture: Fixture, overrides: Record<string, string | undefined> = {}): TestEnvironment {
  const result: Record<string, string | undefined> = {
    AGENT_CWD: fixture.cwd,
    DATA_DIR: fixture.dataDir,
    DB_PATH: fixture.dbPath,
    PI_AGENT_DIR: fixture.agentDir,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as TestEnvironment;
}

function cli(fixture: Fixture, backupRoot = fixture.backupRoot) {
  return parseCutoverArgs([
    "--apply", "--reset-rc-data", "--confirm-reset", CUTOVER_CONFIRM_TOKEN,
    "--maintenance-window", "CONFIRMED",
    "--backup-root", backupRoot, "--age-recipient-file", fixture.recipient,
  ]);
}

function writeRecipient(fixture: Fixture): void {
  writeFileSync(fixture.recipient, "age1faketestrecipient000000000000000000000000000\n", { mode: 0o600 });
}

/** 与 cutover-core canonicalCutoverPath 相同的 canonical 形式（macOS /var → /private/var 等系统别名）。 */
function canonical(input: string): string {
  let existing = path.resolve(input);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...suffix);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function verifyMigrationSnapshot(fixture: Fixture, dbPath: string) {
  const directory = mkdtempSync(path.join(fixture.root, "verify-snapshot-"));
  cleanups.push(directory);
  const copy = path.join(directory, "snapshot.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${copy}${suffix}`);
  }
  const before = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => existsSync(file) ? sha256(file) : null);
  const db = new DatabaseSync(copy, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    return await runSqliteMigrations(db, { mode: "verify" });
  } finally {
    db.close();
    const after = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => existsSync(file) ? sha256(file) : null);
    expect(after).toEqual(before);
  }
}

async function buildOperations(fixture: Fixture, age: AgeAdapter = fakeAge()) {
  const target = resolveSqliteCutoverTarget(environment(fixture), cli(fixture));
  return {
    target,
    operations: {
      createBackup: () => createSqliteBackup({
        paths: { dataDir: target.dataDir, agentDir: target.agentDir, dbPath: target.dbPath, backupRoot: target.backupRoot, ageRecipientFile: target.ageRecipientFile },
        backupKind: "pre-reset" as const,
        age,
      }),
      verifyBackup: verifyPublishedBackup,
      reset: () => resetSqliteForCutover(target),
      applyMigration: () => applySqliteMigrationsAfterReset(target.dbPath),
      verifyMigration: () => verifyMigrationSnapshot(fixture, target.dbPath),
    },
  };
}

async function runFullCutover(fixture: Fixture, age: AgeAdapter = fakeAge()) {
  writeRecipient(fixture);
  const { operations } = await buildOperations(fixture, age);
  return runControlledCutover(authorizeCutover(cli(fixture)), operations, { dialect: "SQLite" });
}

function assertNoMigrationLedger(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get()).toBeUndefined();
  } finally {
    db.close();
  }
}

describe("cutover core（SQLite 受控 reset 与演练）", () => {
  it("applies the full controlled sequence on a legacy database and rebuilds an empty migrated baseline", async () => {
    const fixture = await createLegacyFixture();
    const report = await runFullCutover(fixture);

    expect(report.status).toBe("success");
    expect(report.dialect).toBe("SQLite");
    expect(report.legacy).toBe(true);
    expect(report.backup.kind).toBe("pre-reset");
    expect(report.backup.version).toBeNull();
    expect(report.backup.migrationLedgerPresent).toBe(false);
    expect(report.migration.appliedVersion).toBe(HEAD_VERSION);
    expect(report.migration.pending).toBe(0);
    expect(report.verify.status).toBe("verified");
    expect(report.verify.appliedVersion).toBe(HEAD_VERSION);
    expect(report.notes.join(" ")).toMatch(/not claimed/);

    // DB 重建为迁移基线：ledger 存在且到 head。
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    const ledger = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    db.close();
    expect(ledger.map((row) => row.version)).toEqual(Array.from({ length: HEAD_VERSION + 1 }, (_, index) => index));

    // 会话 JSONL 根被清空；models.json/auth.json/cwd 文件全部保留。
    expect(existsSync(path.join(fixture.dataDir, "sessions"))).toBe(false);
    expect(existsSync(path.join(fixture.dataDir, "projects"))).toBe(false);
    expect(readFileSync(path.join(fixture.agentDir, "models.json"), "utf8")).toBe('{"models":[]}\n');
    expect(readFileSync(path.join(fixture.dataDir, "auth.json"), "utf8")).toBe('{"token":"never-touch"}\n');
    expect(readFileSync(path.join(fixture.cwd, "unrelated.txt"), "utf8")).toBe("cwd must survive cutover\n");

    // 备份包已发布且带 COMPLETE 标记。
    const packages = readdirSync(fixture.backupRoot);
    expect(packages).toHaveLength(1);
    expect(existsSync(path.join(fixture.backupRoot, packages[0]!, "COMPLETE"))).toBe(true);
    // 报告脱敏：不包含任何路径/URL。
    expect(JSON.stringify(report)).not.toContain(fixture.root);
  }, 30_000);

  it("performs zero writes during target resolution (dry-run contract)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    resolveSqliteCutoverTarget(environment(fixture), cli(fixture));
    expect(existsSync(fixture.backupRoot)).toBe(false);
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
    expect(existsSync(fixture.dbPath)).toBe(true);
  });

  it("resets nothing when the backup fails (DB/WAL/JSONL/models/auth all preserved)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const beforeDb = sha256(fixture.dbPath);
    const beforeSession = sha256(fixture.sessionFile);
    await expect(runFullCutover(fixture, failingAge())).rejects.toThrow(/injected age failure/);
    expect(sha256(fixture.dbPath)).toBe(beforeDb);
    expect(sha256(fixture.sessionFile)).toBe(beforeSession);
    expect(existsSync(path.join(fixture.agentDir, "models.json"))).toBe(true);
    // 失败的备份不发布任何 package（backup root 至多存在且为空）。
    expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
  });

  it("refuses to run without the exact confirmation chain (wrong token => zero deletion)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const beforeDb = sha256(fixture.dbPath);
    expect(() => authorizeCutover({ ...cli(fixture), confirmReset: "delete_rc_data" })).toThrow(/confirmation token mismatch/);
    expect(() => authorizeCutover({ ...cli(fixture), resetRcData: false })).toThrow(/--reset-rc-data/);
    expect(() => authorizeCutover({ ...cli(fixture), maintenanceWindowConfirmed: false })).toThrow(/maintenance-window/);
    expect(sha256(fixture.dbPath)).toBe(beforeDb);
    expect(existsSync(fixture.backupRoot)).toBe(false);
  });

  it("keeps the backup and reports no success when migration fails after reset (no auto restore)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const { operations } = await buildOperations(fixture);
    const broken = { ...operations, applyMigration: async () => { throw new Error("injected migration failure"); } };
    await expect(runControlledCutover(authorizeCutover(cli(fixture)), broken, { dialect: "SQLite" }))
      .rejects.toThrow(/injected migration failure/);
    // 备份保留；绝不自动 restore/down：DB 未被复活为带 ledger 的迁移基线。
    expect(readdirSync(fixture.backupRoot)).toHaveLength(1);
    assertNoMigrationLedger(fixture.dbPath);
  });

  it("records legacy backup metadata (kind=pre-reset, absent migration ledger, auth excluded)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const { operations } = await buildOperations(fixture);
    const backup = await operations.createBackup();
    expect(backup.manifest?.kind).toBe("pre-reset");
    expect(backup.manifest?.migrationLedger.present).toBe(false);
    expect(backup.manifest?.migrationLedger.appliedVersion).toBeNull();
    expect(backup.manifest?.excludedFiles.some((entry) => entry.path === "sessions/auth.json")).toBe(true);
    const verification = operations.verifyBackup(backup);
    expect(verification.kind).toBe("pre-reset");
    expect(verification.version).toBeNull();
  });

  it("rejects unsafe SQLite targets: memory naming, symlink, hardlink, relative env paths, overlaps", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);

    // 相对 DB_PATH / 相对 AGENT_CWD / 缺失 AGENT_CWD。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DB_PATH: "relative.db" }), cli(fixture))).toThrow(/relative/);
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { AGENT_CWD: "relative/cwd" }), cli(fixture))).toThrow(/absolute/);
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { AGENT_CWD: undefined }), cli(fixture))).toThrow(/AGENT_CWD/);

    // symlink DB。
    const link = path.join(fixture.root, "linked.db");
    symlinkSync(fixture.dbPath, link);
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DB_PATH: link }), cli(fixture))).toThrow(/symbolic/);

    // hardlink DB。
    const hard = path.join(fixture.root, "hard.db");
    linkSync(fixture.dbPath, hard);
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DB_PATH: hard }), cli(fixture))).toThrow(/hardlink/);
    rmSync(hard, { force: true }); // 恢复源 DB 单链接状态，供后续用例继续

    // backup root 在 dataDir 内。
    expect(() => resolveSqliteCutoverTarget(environment(fixture), cli(fixture, path.join(fixture.dataDir, "backups")))).toThrow(/overlap/);

    // dataDir 在 backup root 内（双向 overlap；DB 需先存在以到达 overlap 检查）。
    const nestedData = path.join(fixture.backupRoot, "nested", "data");
    mkdirSync(nestedData, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(nestedData, "pi-agent-server.db"), "placeholder");
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DATA_DIR: nestedData, DB_PATH: path.join(nestedData, "pi-agent-server.db") }), cli(fixture)))
      .toThrow(/overlap/);

    // DB 在 dataDir 之外（先创建以越过存在性检查，命中布局拒绝）。
    const outside = path.join(fixture.root, "outside.db");
    writeFileSync(outside, "placeholder");
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DB_PATH: outside }), cli(fixture)))
      .toThrow(/inside the resolved data directory/);

    // ":memory:" 命名拒绝。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DB_PATH: path.join(fixture.dataDir, ":memory:") }), cli(fixture)))
      .toThrow(/in-memory/);
  });

  it("rejects non-allowlisted PG schemas before executing any DDL", async () => {
    const queries: string[] = [];
    const spy = { query: async (text: string) => { queries.push(text); return { rows: [{ current_user: "spy" }] }; } };
    for (const schema of ["public", "pi_restore_tmp", "app", "pg_catalog"]) {
      await expect(resetPostgresSchemaForCutover(spy, schema)).rejects.toThrow();
    }
    expect(queries).toHaveLength(0);
    // 允许列表内的 schema 才会产生 DROP/CREATE + 最小授权，且绝不 DROP DATABASE。
    await resetPostgresSchemaForCutover(spy, `${CUTOVER_SCHEMA_PREFIX}abc`);
    expect(queries.map((text) => text.replace(/\s+/g, " "))).toEqual([
      `DROP SCHEMA IF EXISTS "${CUTOVER_SCHEMA_PREFIX}abc" CASCADE`,
      `CREATE SCHEMA "${CUTOVER_SCHEMA_PREFIX}abc"`,
      "SELECT current_user",
      `GRANT USAGE, CREATE ON SCHEMA "${CUTOVER_SCHEMA_PREFIX}abc" TO "spy"`,
    ]);
    expect(validateCutoverTargetSchema(`${CUTOVER_SCHEMA_PREFIX}abc`)).toBe(`${CUTOVER_SCHEMA_PREFIX}abc`);
  });
});

describe("cutover path-safety resolver（WP2A P0-2：显式 DATA_DIR / cwd 隔离 / 实际凭证位置）", () => {
  it("rejects a missing or blank DATA_DIR instead of silently inheriting the process cwd", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DATA_DIR: undefined }), cli(fixture)))
      .toThrow(/explicit absolute DATA_DIR/);
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DATA_DIR: "   " }), cli(fixture)))
      .toThrow(/explicit absolute DATA_DIR/);
    expect(() => resolvePostgresCutoverTarget(environment(fixture, { DATA_DIR: undefined }), cli(fixture)))
      .toThrow(/explicit absolute DATA_DIR/);
  });

  it("rejects DATA_DIR equal to, containing, or contained in AGENT_CWD in both directions", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    // 相等。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DATA_DIR: fixture.cwd }), cli(fixture)))
      .toThrow(/must not overlap the agent cwd/);
    // dataDir 包含 cwd（另一方向同样拒绝）。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { DATA_DIR: fixture.root }), cli(fixture)))
      .toThrow(/must not overlap the agent cwd/);
    // PG resolver 同一边界。
    expect(() => resolvePostgresCutoverTarget(environment(fixture, { DATA_DIR: fixture.cwd }), cli(fixture)))
      .toThrow(/must not overlap the agent cwd/);
  });

  it("resolves PI_AUTH_PATH / PI_AGENT_DIR and rejects any overlap between the real credential location and the reset surface", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    // 自定义命名的凭证（不叫 auth.json）落在 sessions 根内 → 拒绝。
    const hiddenCredential = path.join(fixture.dataDir, "sessions", "s1", "custom-credential.txt");
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { PI_AUTH_PATH: hiddenCredential }), cli(fixture)))
      .toThrow(/overlaps the destructive reset surface/);
    // 凭证目录反向包含 dataDir（另一方向 overlap）→ 拒绝。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { PI_AUTH_PATH: fixture.root }), cli(fixture)))
      .toThrow(/overlaps the destructive reset surface/);
    // SQLite DB/WAL/SHM 也属于破坏面：凭证指向 DB 本身 → 拒绝。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { PI_AUTH_PATH: fixture.dbPath }), cli(fixture)))
      .toThrow(/overlaps the destructive reset surface/);
    // 安全位置的自定义凭证与自定义 agentDir 正常解析（resolver 真正读取 PI_AUTH_PATH/PI_AGENT_DIR）。
    const customAgent = path.join(fixture.root, "custom-agent");
    mkdirSync(customAgent, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(customAgent, "models.json"), '{"models":[]}\n', { mode: 0o600 });
    const target = resolveSqliteCutoverTarget(
      environment(fixture, { PI_AGENT_DIR: customAgent, PI_AUTH_PATH: path.join(fixture.root, "creds", "service.auth") }),
      cli(fixture),
    );
    expect(target.modelsPath).toBe(path.join(realpathSync(customAgent), "models.json"));
    expect(target.authPath).toBe(path.join(realpathSync(fixture.root), "creds", "service.auth"));
  });

  it("enforces the same boundary for PostgreSQL targets without SQLite file-DB checks", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    // 凭证指向 sessions 根本身 → 拒绝。
    expect(() => resolvePostgresCutoverTarget(
      environment(fixture, { PI_AUTH_PATH: path.join(fixture.dataDir, "sessions") }), cli(fixture),
    )).toThrow(/overlaps the destructive reset surface/);
    // 安全配置：PG target 正常解析，且不做 DB 文件存在性检查（无 DB_PATH 要求）。
    const target = resolvePostgresCutoverTarget(environment(fixture), cli(fixture));
    expect(target.dialect).toBe("postgres");
    expect(target.dataDir).toBe(canonical(fixture.dataDir));
    expect(target.modelsPath).toBe(path.join(canonical(fixture.agentDir), "models.json"));
  });
});

describe("reset binding revalidation（WP2A P1-5：任何目标变化 = 零 reset）", () => {
  async function backupVerification(fixture: Fixture, target: ReturnType<typeof resolveSqliteCutoverTarget>): Promise<PublishedBackupVerification> {
    const backup = await createSqliteBackup({
      paths: { dataDir: target.dataDir, agentDir: target.agentDir, dbPath: target.dbPath, backupRoot: target.backupRoot, ageRecipientFile: target.ageRecipientFile },
      backupKind: "pre-reset" as const,
      age: fakeAge(),
    });
    return verifyPublishedBackup(backup);
  }

  it("passes when nothing changed and fails with zero deletion when the DB was replaced after the backup", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolveSqliteCutoverTarget(environment(fixture), cli(fixture));
    const verification = await backupVerification(fixture, target);
    expect(verification.sqliteTarget).not.toBeNull();
    expect(() => revalidateSqliteCutoverTarget(environment(fixture), cli(fixture), target, verification)).not.toThrow();

    // 备份后替换 DB（新 inode + 新内容）→ 复验失败且零删除。
    rmSync(target.dbPath, { force: true });
    const replacement = new DatabaseSync(target.dbPath);
    await initializeDatabase(replacement);
    replacement.close();
    expect(() => revalidateSqliteCutoverTarget(environment(fixture), cli(fixture), target, verification))
      .toThrow(/refusing to reset a different\/replaced database/);
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
    expect(existsSync(target.dbPath)).toBe(true);
    expect(existsSync(path.join(fixture.agentDir, "models.json"))).toBe(true);
    expect(existsSync(fixture.backupRoot)).toBe(true); // 备份保留，绝不自动清理
  });

  it("fails with zero deletion on a content-only change of the same database file", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolveSqliteCutoverTarget(environment(fixture), cli(fixture));
    const verification = await backupVerification(fixture, target);
    const db = new DatabaseSync(target.dbPath);
    db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)").run("p-after-backup", "changed", "/changed", "owner", 2);
    db.close();
    expect(() => revalidateSqliteCutoverTarget(environment(fixture), cli(fixture), target, verification))
      .toThrow(/refusing to reset a different\/replaced database/);
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
  });

  it("fails when the published backup was taken from different source roots", async () => {
    const source = await createLegacyFixture();
    writeRecipient(source);
    const other = await createLegacyFixture();
    writeRecipient(other);
    const sourceTarget = resolveSqliteCutoverTarget(environment(source), cli(source));
    const verification = await backupVerification(source, sourceTarget);
    const otherTarget = resolveSqliteCutoverTarget(environment(other), cli(other));
    expect(() => revalidateSqliteCutoverTarget(environment(other), cli(other), otherTarget, verification))
      .toThrow(/different source roots/);
    expect(existsSync(path.join(other.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
  });

  it("fails when the manifest has no authenticated source roots or no SQLite DB/WAL/SHM binding", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolveSqliteCutoverTarget(environment(fixture), cli(fixture));
    const verification = await backupVerification(fixture, target);
    expect(verification.sqliteTreeBinding).not.toBeNull();
    expect(() => revalidateSqliteCutoverTarget(environment(fixture), cli(fixture), target, { ...verification, sourceRoots: null }))
      .toThrow(/no authenticated source roots/);
    expect(() => revalidateSqliteCutoverTarget(environment(fixture), cli(fixture), target, { ...verification, sqliteTreeBinding: null }))
      .toThrow(/no SQLite DB\/WAL\/SHM binding/);
  });

  it("fails with zero deletion after a WAL-only commit that the single-file DB binding cannot see", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolveSqliteCutoverTarget(environment(fixture), cli(fixture));
    // 预先把库切到 WAL（在备份前完成，避免 journal-mode 头部变化污染对比）。
    const warmup = new DatabaseSync(target.dbPath);
    warmup.exec("PRAGMA journal_mode=WAL");
    warmup.close();
    const verification = await backupVerification(fixture, target);
    // WAL-only 写入：writer 连接保持打开（不 checkpoint），主 DB 文件不变，只有 -wal 增长。
    const writer = new DatabaseSync(target.dbPath);
    try {
      writer.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("p-wal-only", "wal", "/wal", "owner", 3);
      expect(() => revalidateSqliteCutoverTarget(environment(fixture), cli(fixture), target, verification))
        .toThrow(/source SQLite WAL changed after the backup was taken/);
    } finally { writer.close(); }
    // 零删除：JSONL 与 models.json 全部完好。
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
    expect(existsSync(path.join(fixture.agentDir, "models.json"))).toBe(true);
  });

  it("rejects an agentDir that overlaps the destructive reset surface in either direction (incl. PI_AGENT_DIR=DATA_DIR)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    // PI_AGENT_DIR = DATA_DIR：agentDir 整根包含 sessions/projects 根 → 拒绝。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { PI_AGENT_DIR: fixture.dataDir }), cli(fixture)))
      .toThrow(/agent directory overlaps the destructive reset surface/);
    // agentDir 是 dataDir 的祖先（另一方向 overlap；此处会先命中 backup-root overlap，同样拒绝）→ 拒绝。
    expect(() => resolveSqliteCutoverTarget(environment(fixture, { PI_AGENT_DIR: fixture.root }), cli(fixture)))
      .toThrow(/overlap/);
    // PG resolver 同一边界。
    expect(() => resolvePostgresCutoverTarget(environment(fixture, { PI_AGENT_DIR: fixture.dataDir }), cli(fixture)))
      .toThrow(/agent directory overlaps the destructive reset surface/);
    // 默认布局（agentDir=dataDir/.pi-agent）不与破坏面重叠 → 正常解析。
    expect(() => resolveSqliteCutoverTarget(environment(fixture), cli(fixture))).not.toThrow();
  });

  it("revalidates the PostgreSQL cluster/database/schema identity and refuses any drift with zero deletion", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolvePostgresCutoverTarget(environment(fixture), cli(fixture));
    const schema = `${CUTOVER_SCHEMA_PREFIX}reval`;
    const pgIdentityFields = {
      databaseIdentity: postgresIdentity("testdb", "database"),
      schemaIdentity: postgresIdentity(schema, "schema"),
      systemIdentifier: "7234567890123456789",
      databaseOid: "16384",
      schemaOid: "16401",
      serverAddress: "192.0.2.10",
      serverPort: "5432",
      clusterName: null,
    };
    const verification: PublishedBackupVerification = {
      id: "pg-backup",
      kind: "pre-reset",
      checksum: "checksum",
      version: null,
      sourceRoots: { dataDir: target.dataDir, agentDir: target.agentDir },
      sqliteTarget: null,
      sqliteTreeBinding: null,
      postgres: pgIdentityFields,
    };
    const connected = {
      database: "testdb", schema,
      system_identifier: "7234567890123456789", database_oid: "16384", schema_oid: "16401",
      server_address: "192.0.2.10", server_port: "5432", cluster_name: "",
    };
    const client = (row: Record<string, unknown>) => ({ query: async () => ({ rows: [row] }) });
    await expect(revalidatePostgresCutoverTarget(client(connected), schema, target, verification)).resolves.toBeUndefined();
    // effective schema 漂移 → 拒绝。
    await expect(revalidatePostgresCutoverTarget(client({ ...connected, schema: "public" }), schema, target, verification))
      .rejects.toThrow(/no longer matches --target-schema/);
    // manifest identity 与连接 identity 不一致 → 拒绝。
    const forged: PublishedBackupVerification = { ...verification, postgres: { ...pgIdentityFields, databaseIdentity: postgresIdentity("otherdb", "database") } };
    await expect(revalidatePostgresCutoverTarget(client(connected), schema, target, forged))
      .rejects.toThrow(/different PostgreSQL database\/schema identity/);
    // 不同 cluster（system identifier 漂移）→ 拒绝：同名哈希永不作为 cluster 证据。
    await expect(revalidatePostgresCutoverTarget(client({ ...connected, system_identifier: "999888777666555444" }), schema, target, verification))
      .rejects.toThrow(/different PostgreSQL cluster/);
    // 连接无法提供 system identifier（无权限/为空）→ 安全 fail，不回退同名哈希。
    await expect(revalidatePostgresCutoverTarget(client({ ...connected, system_identifier: null }), schema, target, verification))
      .rejects.toThrow(/system identifier is unavailable/);
    // OID 漂移 → 拒绝。
    await expect(revalidatePostgresCutoverTarget(client({ ...connected, database_oid: "17000" }), schema, target, verification))
      .rejects.toThrow(/OID mismatch/);
    // server port 漂移 → 拒绝。
    await expect(revalidatePostgresCutoverTarget(client({ ...connected, server_port: "5433" }), schema, target, verification))
      .rejects.toThrow(/server port changed/);
    // 缺少 PG identity binding / 缺少 source roots → 拒绝。
    await expect(revalidatePostgresCutoverTarget(client(connected), schema, target, { ...verification, postgres: null }))
      .rejects.toThrow(/no PostgreSQL database\/schema identity binding/);
    await expect(revalidatePostgresCutoverTarget(client(connected), schema, target, { ...verification, sourceRoots: null }))
      .rejects.toThrow(/no authenticated source roots/);
    // 复验查询本身失败 → 安全 fail。
    await expect(revalidatePostgresCutoverTarget({ query: async () => { throw new Error("permission denied for pg_control_system"); } }, schema, target, verification))
      .rejects.toThrow(/cluster identity could not be queried/);
    // 零删除：复验失败路径不触碰任何文件。
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
  });

  it("fails closed when the published package was replaced after creation (manifest ciphertext / COMPLETE tamper)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolveSqliteCutoverTarget(environment(fixture), cli(fixture));
    const backup = await createSqliteBackup({
      paths: { dataDir: target.dataDir, agentDir: target.agentDir, dbPath: target.dbPath, backupRoot: target.backupRoot, ageRecipientFile: target.ageRecipientFile },
      backupKind: "pre-reset" as const,
      age: fakeAge(),
    });
    expect(backup.publishedIdentity).not.toBeNull();
    // 完好包：验证通过。
    expect(() => verifyPublishedBackup(backup)).not.toThrow();

    // 替换 manifest ciphertext → 与创建时 digest 不一致 → 零 reset。
    const tamperedManifest = structuredClone(backup);
    const manifestBytes = readFileSync(path.join(backup.finalPath!, "manifest.json.age"));
    const lastByte = manifestBytes.length - 1;
    manifestBytes[lastByte] = (manifestBytes[lastByte] ?? 0) ^ 0x01;
    writeFileSync(path.join(backup.finalPath!, "manifest.json.age"), manifestBytes, { mode: 0o600 });
    expect(() => verifyPublishedBackup(tamperedManifest)).toThrow(/replaced after creation/);

    // 替换 COMPLETE → 与创建时 marker 不一致 → 零 reset。
    const tamperedComplete = structuredClone(backup);
    writeFileSync(path.join(backup.finalPath!, "COMPLETE"), `${"f".repeat(64)}\n`, { mode: 0o600 });
    expect(() => verifyPublishedBackup(tamperedComplete)).toThrow(/replaced after creation/);

    // 无创建时 identity 的结果 → 直接拒绝。
    const anonymous = { ...structuredClone(backup), publishedIdentity: null };
    expect(() => verifyPublishedBackup(anonymous)).toThrow(/no creation-time published identity/);
    // 零删除：验证失败路径不触碰任何文件。
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
  });
});

describe("snapshot→manifest 窗口的 WAL-only 写入（P0-1：immutable binding，零 reset）", () => {
  it("fails the whole cutover with zero deletion when a WAL-only commit lands between the snapshot and the manifest", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    // 预先把库切到 WAL（备份前完成，避免 journal-mode 头部变化污染对比）。
    const warmup = new DatabaseSync(fixture.dbPath);
    warmup.exec("PRAGMA journal_mode=WAL");
    warmup.close();
    const beforeDb = sha256(fixture.dbPath);
    // writer 连接贯穿整个备份并保持打开（不 checkpoint）：第一次 age 调用发生在
    // VACUUM INTO 之后、manifest 写入之前 —— 此时做 WAL-only 写入。
    const writer = new DatabaseSync(fixture.dbPath);
    let wrote = false;
    const age: AgeAdapter = {
      encrypt(input, recipient) {
        if (!wrote) {
          writer.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)")
            .run("p-wal-only-window", "wal", "/wal", "owner", 9);
          wrote = true;
        }
        return fakeAge().encrypt(input, recipient);
      },
    };
    try {
      await expect(runFullCutover(fixture, age)).rejects.toThrow(/source SQLite WAL changed after the backup was taken/);
      expect(wrote).toBe(true);
      // 零 reset：主 DB 文件、会话 JSONL、models.json 全部完好，无备份包发布。
      expect(sha256(fixture.dbPath)).toBe(beforeDb);
      expect(existsSync(fixture.sessionFile)).toBe(true);
      expect(existsSync(path.join(fixture.agentDir, "models.json"))).toBe(true);
      expect(existsSync(fixture.backupRoot) ? readdirSync(fixture.backupRoot) : []).toEqual([]);
    } finally { writer.close(); }
  });
});

describe("PG reset 专用同连接门禁（P0-2：openPostgresDedicatedResetGate，fake client）", () => {
  const schema = `${CUTOVER_SCHEMA_PREFIX}gate`;

  function gatePool(options: { identityRow?: Record<string, unknown>; failOn?: (text: string) => boolean } = {}) {
    const queries: string[] = [];
    let connectCount = 0;
    let released = 0;
    const identityRow = options.identityRow ?? {
      database: "testdb", schema,
      system_identifier: "7234567890123456789", database_oid: "16384", schema_oid: "16401",
      server_address: "192.0.2.10", server_port: "5432", cluster_name: "",
    };
    const client = {
      async query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> {
        queries.push(text);
        if (options.failOn?.(text)) throw new Error(`injected failure at: ${text}`);
        if (text.startsWith("BEGIN ") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.startsWith("DROP SCHEMA") || text.startsWith("CREATE SCHEMA") || text.startsWith("GRANT ")) return { rows: [] };
        if (text.includes("current_database()")) return { rows: [identityRow] };
        if (text === "SELECT current_user") return { rows: [{ current_user: "cutover_role" }] };
        throw new Error(`unexpected gate query: ${text}`);
      },
      release(): void { released++; },
    };
    return {
      pool: { async connect() { connectCount++; return client; } },
      queries,
      connectCount: () => connectCount,
      released: () => released,
    };
  }

  function pgVerification(target: ReturnType<typeof resolvePostgresCutoverTarget>): PublishedBackupVerification {
    return {
      id: "pg-backup",
      kind: "pre-reset",
      checksum: "checksum",
      version: null,
      sourceRoots: { dataDir: target.dataDir, agentDir: target.agentDir },
      sqliteTarget: null,
      sqliteTreeBinding: null,
      postgres: {
        databaseIdentity: postgresIdentity("testdb", "database"),
        schemaIdentity: postgresIdentity(schema, "schema"),
        systemIdentifier: "7234567890123456789",
        databaseOid: "16384",
        schemaOid: "16401",
        serverAddress: "192.0.2.10",
        serverPort: "5432",
        clusterName: null,
      },
    };
  }

  it("runs identity revalidation and DROP/CREATE/GRANT on ONE dedicated client inside ONE transaction, then COMMITs", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolvePostgresCutoverTarget(environment(fixture), cli(fixture));
    const harness = gatePool();
    const gate = openPostgresDedicatedResetGate(harness.pool, schema, target);
    await gate.revalidate(pgVerification(target));
    await gate.reset();
    await gate.cleanup();
    // 同一 client：只 connect 一次、release 一次（杜绝 Pool 连接切换）。
    expect(harness.connectCount()).toBe(1);
    expect(harness.released()).toBe(1);
    const normalized = harness.queries.map((text) => text.replace(/\s+/g, " "));
    expect(normalized).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ",
      expect.stringContaining("current_database()"),
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      `CREATE SCHEMA "${schema}"`,
      "SELECT current_user",
      `GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "cutover_role"`,
      "COMMIT",
    ]);
    expect(harness.queries.join(" ")).not.toContain("DROP DATABASE");
    // JSONL file reset 在 reset 步骤内执行。
    expect(existsSync(path.join(fixture.dataDir, "sessions"))).toBe(false);
    expect(existsSync(path.join(fixture.dataDir, "projects"))).toBe(false);
    expect(readFileSync(path.join(fixture.agentDir, "models.json"), "utf8")).toBe('{"models":[]}\n');
  });

  it("rolls back and releases with zero deletion when revalidation fails on the dedicated client", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolvePostgresCutoverTarget(environment(fixture), cli(fixture));
    const harness = gatePool({ identityRow: { database: "testdb", schema: "public", system_identifier: "7234567890123456789", database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" } });
    const gate = openPostgresDedicatedResetGate(harness.pool, schema, target);
    await expect(gate.revalidate(pgVerification(target))).rejects.toThrow(/no longer matches --target-schema/);
    await gate.cleanup();
    expect(harness.connectCount()).toBe(1);
    expect(harness.released()).toBe(1);
    expect(harness.queries.at(-1)).toBe("ROLLBACK");
    expect(harness.queries.some((text) => text.startsWith("DROP SCHEMA"))).toBe(false);
    expect(harness.queries).not.toContain("COMMIT");
    // 零删除：JSONL 与 models.json 全部完好。
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
    expect(existsSync(path.join(fixture.agentDir, "models.json"))).toBe(true);
  });

  it("rolls back the DDL without COMMIT when the reset fails mid-transaction", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolvePostgresCutoverTarget(environment(fixture), cli(fixture));
    const harness = gatePool({ failOn: (text) => text.includes("CREATE SCHEMA") });
    const gate = openPostgresDedicatedResetGate(harness.pool, schema, target);
    await gate.revalidate(pgVerification(target));
    await expect(gate.reset()).rejects.toThrow(/injected failure/);
    expect(harness.queries.at(-1)).toBe("ROLLBACK");
    expect(harness.queries).not.toContain("COMMIT");
    await gate.cleanup();
    expect(harness.released()).toBe(1);
  });

  it("refuses to reset before revalidation opened the dedicated transaction (zero queries, zero deletion)", async () => {
    const fixture = await createLegacyFixture();
    writeRecipient(fixture);
    const target = resolvePostgresCutoverTarget(environment(fixture), cli(fixture));
    const harness = gatePool();
    const gate = openPostgresDedicatedResetGate(harness.pool as never, schema, target);
    await expect(gate.reset()).rejects.toThrow(/not open/);
    expect(harness.queries).toEqual([]);
    expect(harness.connectCount()).toBe(0);
    expect(existsSync(path.join(fixture.dataDir, "sessions", "s1", "history.jsonl"))).toBe(true);
  });
});
