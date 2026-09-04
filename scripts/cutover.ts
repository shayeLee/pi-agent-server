#!/usr/bin/env node
// WP2A 受控 cutover 离线 CLI。设计边界：
// - 绝不自动 reset 之外的东西：reset 仅在显式确认链（--reset-rc-data +
//   --confirm-reset DELETE_RC_DATA + --maintenance-window CONFIRMED）与已验证 pre-reset 备份之后执行；
// - dry-run 零写入；apply 顺序固定：备份 → 备份验证 → reset → migration apply → strict verify head；
// - 任何失败不报成功；migration 失败保留备份、绝不自动 restore/down；
// - 不接入 startServer、不启动服务、不安装 scheduler/timer。真实 cutover 仍需用户事后明确目标授权。

import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createPostgresBackup,
  redactPgDiagnostic,
} from "../src/backup/postgres-backup-core.js";
import { createSqliteBackup, verifyPublishedBackup } from "../src/backup/backup-core.js";
import { runPostgresMigrations, runSqliteMigrations } from "../src/storage/migration-engine.js";
import {
  authorizeCutover,
  CUTOVER_USAGE,
  CUTOVER_SCHEMA_PREFIX,
  parseCutoverArgs,
  openPostgresDedicatedResetGate,
  resetSqliteForCutover,
  resolvePostgresCutoverTarget,
  resolveSqliteCutoverTarget,
  revalidateSqliteCutoverTarget,
  runControlledCutover,
  applySqliteMigrationsAfterReset,
  validateCutoverTargetSchema,
  type CutoverCliOptions,
} from "../src/cutover/cutover-core.js";
import { createPostgresKysely, createPostgresPool } from "../src/storage/postgres-bootstrap.js";
import {
  resolveBackupCliPaths,
  resolveStorageConfig,
  summarizePostgresTarget,
  validateMigrationCliPathValues,
  type StorageEnvironment,
} from "../src/storage/storage-config.js";
import { APPLY_STAGE_BUDGET_MS, type StageReporter } from "../src/backup/stage-guard.js";
import { redactedMessage } from "./migrate.js";

async function runSqliteCutover(cli: CutoverCliOptions, environment: StorageEnvironment): Promise<void> {
  const target = resolveSqliteCutoverTarget(environment, cli);
  const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
  if (cli.mode === "dry-run") {
    // 零写入：仅解析与只读检查，输出计划。
    console.log(JSON.stringify({
      status: "planned",
      mode: "dry-run",
      dialect: "SQLite",
      steps: ["pre-reset encrypted backup (kind=pre-reset)", "backup COMPLETE/manifest/hash verification", "target binding revalidation (source roots + DB stat fingerprint; any change = zero reset)", "controlled reset (DB/WAL/SHM + dataDir sessions/ and projects/ roots)", "manifest-driven migration apply", "strict verify head"],
      preserved: ["agentDir service config (models.json)", "the actual resolved credential path is never backed up or deleted"],
    }));
    return;
  }
  const authorization = authorizeCutover(cli);
  const report: StageReporter = (stage, state) => console.log(`[cutover] stage=${stage} state=${state}`);
  const result = await runControlledCutover(authorization, {
    createBackup: () => createSqliteBackup({ paths: { ...paths, authPath: target.authPath }, backupKind: "pre-reset", stagingRoot: environment.PI_BACKUP_STAGING_ROOT }),
    verifyBackup: verifyPublishedBackup,
    revalidateBeforeReset: (verification) => revalidateSqliteCutoverTarget(environment, cli, target, verification),
    reset: () => resetSqliteForCutover(target),
    applyMigration: () => applySqliteMigrationsAfterReset(target.dbPath),
    verifyMigration: async () => {
      // 严格 verify 用只读快照（WAL 下直接只读打开也可能写 -shm），并断言源 DB 未被触碰。
      const directory = path.join(path.dirname(paths.backupRoot), `.pi-agent-cutover-verify-${process.pid}-${Date.now()}`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const copy = path.join(directory, "snapshot.db");
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${target.dbPath}${suffix}`;
        if (existsSync(source)) copyFileSync(source, `${copy}${suffix}`);
      }
      const before = sqliteFingerprints(target.dbPath);
      const db = new DatabaseSync(copy, { timeout: 5000, readOnly: true, enableForeignKeyConstraints: true });
      try {
        return await runSqliteMigrations(db, { mode: "verify" });
      } finally {
        db.close();
        rmSync(directory, { recursive: true, force: true });
        assertUnchanged(before, target.dbPath);
      }
    },
  }, { dialect: "SQLite", onStage: report });
  console.log(JSON.stringify(result));
}

function sqliteFingerprints(dbFile: string): Record<string, string | null> {
  const fingerprints: Record<string, string | null> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbFile}${suffix}`;
    try {
      fingerprints[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch { fingerprints[file] = null; }
  }
  return fingerprints;
}

function assertUnchanged(before: Record<string, string | null>, dbFile: string): void {
  const after = sqliteFingerprints(dbFile);
  for (const file of Object.keys(before)) {
    if (before[file] !== after[file]) throw new Error("cutover: SQLite target changed unexpectedly during verify");
  }
}

async function runPostgresCutover(cli: CutoverCliOptions, environment: StorageEnvironment): Promise<void> {
  if (environment.PI_STORAGE_DIALECT?.trim().toLowerCase() !== "postgres") {
    throw new Error("cutover: PostgreSQL reset requires explicit PI_STORAGE_DIALECT=postgres");
  }
  const storage = resolveStorageConfig({}, "", environment);
  if (storage.dialect !== "postgres") throw new Error("cutover: PostgreSQL dialect resolution failed safely");
  if (!cli.targetSchema) throw new Error(`${CUTOVER_USAGE}；PostgreSQL reset 需要显式 --target-schema（专用 ${CUTOVER_SCHEMA_PREFIX}* schema）`);
  const schema = validateCutoverTargetSchema(cli.targetSchema);
  const target = resolvePostgresCutoverTarget(environment, cli);
  const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
  if (cli.mode === "dry-run") {
    console.log(JSON.stringify({
      status: "planned",
      mode: "dry-run",
      dialect: "PostgreSQL",
      target: summarizePostgresTarget(storage.databaseUrl),
      schema,
      steps: ["pre-reset encrypted pg_dump backup (kind=pre-reset)", "backup COMPLETE/manifest/hash verification", "target binding revalidation (source roots + database/schema identity; any mismatch = zero reset)", "controlled JSONL reset (dataDir sessions/ and projects/ roots)", `DROP SCHEMA ... CASCADE + CREATE SCHEMA + minimal grants (never DROP DATABASE; schema prefix ${CUTOVER_SCHEMA_PREFIX} only)`, "manifest-driven migration apply", "strict verify head"],
      preserved: ["agentDir service config (models.json)", "the actual resolved credential path is never backed up or deleted"],
    }));
    return;
  }
  const authorization = authorizeCutover(cli);
  const report: StageReporter = (stage, state) => console.log(`[cutover] stage=${stage} state=${state}`);
  // 门禁连接池有界：挂起查询不能泄漏连接或挂死 CLI。
  const pool = createPostgresPool(storage.databaseUrl, {
    connectionTimeoutMillis: 5_000,
    statementTimeoutMs: APPLY_STAGE_BUDGET_MS.migrationApply,
    queryTimeoutMs: APPLY_STAGE_BUDGET_MS.migrationApply,
  });
  const kysely = createPostgresKysely(pool);
  // P0：reset 专用同连接门禁——identity 复验与 DROP/CREATE/GRANT 持有同一个
  // 专用 PoolClient/事务，杜绝 Pool 连接切换；绝不 DROP DATABASE。
  const resetGate = openPostgresDedicatedResetGate(pool, schema, target);
  try {
    const identity = await pool.query<{ database: string; schema: string | null; current_user: string }>(
      "SELECT current_database() AS database, current_schema() AS schema, current_user AS current_user",
    );
    const row = identity.rows[0];
    if (!row) throw new Error("cutover: PostgreSQL connection returned no target identity");
    if (row.schema !== schema) {
      // 拒绝歧义 target：连接的 effective schema 必须与 --target-schema 完全一致，
      // 否则 reset 后 migration 可能落到错误 schema。
      throw new Error(`cutover: connection effective schema (${row.schema ?? "none"}) does not match --target-schema (${schema}); refusing ambiguous reset`);
    }
    const result = await runControlledCutover(authorization, {
      createBackup: () => createPostgresBackup({
        storageDialect: "postgres",
        databaseUrl: storage.databaseUrl,
        paths: { dataDir: paths.dataDir, agentDir: paths.agentDir, authPath: target.authPath, backupRoot: paths.backupRoot, ageRecipientFile: paths.ageRecipientFile },
        backupKind: "pre-reset",
        stagingRoot: environment.PI_BACKUP_STAGING_ROOT,
        onStage: report,
      }),
      verifyBackup: verifyPublishedBackup,
      revalidateBeforeReset: (verification) => resetGate.revalidate(verification),
      // 备份验证 + binding 复验之后、schema DROP 之前：与 SQLite 同一边界清理
      // dataDir 内 sessions//projects/ JSONL 根（保留 models.json、绝不触凭证）；
      // DROP/CREATE/GRANT 在同一专用 client/transaction 内执行，COMMIT 成功才生效。
      reset: () => resetGate.reset(),
      applyMigration: () => runPostgresMigrations(kysely, { mode: "apply" }),
      verifyMigration: () => runPostgresMigrations(kysely, { mode: "verify" }),
    }, { dialect: "PostgreSQL", schema, onStage: report });
    console.log(JSON.stringify(result));
  } finally {
    await resetGate.cleanup();
    await kysely.destroy();
  }
}

async function main(): Promise<void> {
  const cli = parseCutoverArgs(process.argv.slice(2));
  const environment = process.env as StorageEnvironment;
  validateMigrationCliPathValues(environment);
  if (environment.PI_STORAGE_DIALECT?.trim().toLowerCase() === "postgres") {
    await runPostgresCutover(cli, environment);
  } else {
    await runSqliteCutover(cli, environment);
  }
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

function redact(error: unknown): string {
  return redactedMessage(redactPgDiagnostic(error instanceof Error ? error.message : String(error)), process.env.PI_DATABASE_URL?.trim());
}

if (isCliEntry()) {
  void main().catch((error: unknown) => {
    console.error(`[cutover] ${redact(error)}`);
    process.exitCode = error instanceof Error && error.message.startsWith("用法：") ? 2 : 1;
  });
}
