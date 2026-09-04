#!/usr/bin/env node
// WP1/WP3C offline migration tool. It is deliberately not called from
// startServer and never starts a scheduler, retention worker, or runtime.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync, statSync, readFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPostgresKysely, createPostgresPool } from "../src/storage/postgres-bootstrap.js";
import type { Pool } from "pg";
import {
  abortActiveAgeChild,
  createPostgresBackup,
  createSqliteBackup,
  verifyPublishedBackup,
  type AnyBackupManifest,
  type PostgresBackupResult,
  type BackupResult,
  type PublishedBackupVerification,
} from "../src/backup/backup-core.js";
import { runPostgresMigrations, runSqliteMigrations, type MigrationRunResult } from "../src/storage/migration-engine.js";
import { migrationDefinitions } from "../src/storage/migration-manifest.js";
import { resolveBackupCliPaths, resolveMigrationCliPaths, resolveStorageConfig, summarizePostgresTarget, validateMigrationCliPathValues, type StorageEnvironment } from "../src/storage/storage-config.js";
import {
  APPLY_STAGE_BUDGET_MS,
  withStageTimeout,
  type StageReporter,
} from "../src/backup/stage-guard.js";

const USAGE = "用法：pnpm migrate -- --dry-run|--verify|--apply [--backup-root ABSOLUTE_DIR --age-recipient-file ABSOLUTE_FILE --maintenance-window CONFIRMED]";

export interface MigrateCliOptions {
  readonly mode: "apply" | "dry-run" | "verify";
  readonly backupRoot?: string;
  readonly ageRecipientFile?: string;
  readonly maintenanceWindowConfirmed: boolean;
}

export function parseMigrateArgs(args: readonly string[]): MigrateCliOptions {
  const actual = args[0] === "--" ? args.slice(1) : args;
  const modes = actual.filter((arg) => arg === "--apply" || arg === "--dry-run" || arg === "--verify");
  if (modes.length !== 1) throw new Error(USAGE);
  const mode = modes[0]!.slice(2) as MigrateCliOptions["mode"];
  let backupRoot: string | undefined;
  let ageRecipientFile: string | undefined;
  let maintenanceWindowConfirmed = false;
  for (let index = 0; index < actual.length; index++) {
    const arg = actual[index]!;
    if (arg === "--apply" || arg === "--dry-run" || arg === "--verify") continue;
    if (arg === "--backup-root") {
      if (backupRoot !== undefined || !actual[index + 1]) throw new Error(`${USAGE}；需要 --backup-root 绝对路径`);
      backupRoot = actual[++index];
    } else if (arg === "--age-recipient-file") {
      if (ageRecipientFile !== undefined || !actual[index + 1]) throw new Error(`${USAGE}；需要 --age-recipient-file 绝对路径`);
      ageRecipientFile = actual[++index];
    } else if (arg === "--maintenance-window") {
      const value = actual[index + 1];
      if (!value || value.toUpperCase() !== "CONFIRMED") throw new Error(`${USAGE}；--maintenance-window 必须为 CONFIRMED`);
      maintenanceWindowConfirmed = true;
      index++;
    } else if (arg.startsWith("--maintenance-window=")) {
      if (arg.slice("--maintenance-window=".length).toUpperCase() !== "CONFIRMED") throw new Error(`${USAGE}；--maintenance-window 必须为 CONFIRMED`);
      maintenanceWindowConfirmed = true;
    } else {
      // Do not echo an unknown argument: it may be a token, key, or another
      // secret-bearing value supplied accidentally on the command line.
      throw new Error(`${USAGE}；未知参数`);
    }
  }
  if (mode === "apply") {
    if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error(`${USAGE}；apply 必须显式提供绝对 --backup-root`);
    if (!ageRecipientFile || !path.isAbsolute(ageRecipientFile)) throw new Error(`${USAGE}；apply 必须显式提供绝对 --age-recipient-file`);
    if (!maintenanceWindowConfirmed) throw new Error(`${USAGE}；apply 必须显式提供 --maintenance-window CONFIRMED`);
  }
  return { mode, backupRoot, ageRecipientFile, maintenanceWindowConfirmed };
}

export function parseMode(args: readonly string[]): "apply" | "dry-run" | "verify" {
  return parseMigrateArgs(args).mode;
}

/** CLI-side defense in depth: never print a successful verify/apply below head. */
export function assertCliMigrationHead(
  result: MigrationRunResult,
  canonicalHead = migrationDefinitions.at(-1)!.version,
): void {
  if (result.mode === "dry-run") return;
  if (result.status !== "verified" && result.status !== "applied" || result.pending.length !== 0 || result.appliedVersion !== canonicalHead) {
    throw new Error(`migration ${result.mode} did not reach the canonical migration head (applied v${String(result.appliedVersion)}, canonical head v${canonicalHead}, pending ${result.pending.length})`);
  }
}

function printResult(result: MigrationRunResult): void {
  assertCliMigrationHead(result);
  console.log(`migration mode: ${result.mode}`);
  console.log("migration plan:");
  if (result.pending.length === 0) console.log("  (no pending migrations)");
  else for (const migration of result.pending) console.log(`  v${migration.version} ${migration.name} checksum=${migration.checksum}`);
  if (result.status === "applied") console.log(`migration result: applied through v${result.appliedVersion}`);
  if (result.status === "verified") console.log("migration result: verified");
  if (result.status === "planned") console.log("migration result: dry-run; no database writes");
}

export function redactedMessage(error: unknown, databaseUrl: string | undefined): string {
  let message = error instanceof Error ? error.message : String(error);
  const credentialValues = new Set<string>();
  if (databaseUrl) {
    message = message.split(databaseUrl).join("[redacted database URL]");
    try {
      const target = new URL(databaseUrl);
      for (const value of [target.username, target.password]) {
        if (!value) continue;
        credentialValues.add(value);
        try { credentialValues.add(decodeURIComponent(value)); } catch { /* keep the encoded form */ }
      }
    } catch { /* the full URL redaction below is sufficient */ }
  }
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[redacted database URL]");
  message = message.replace(/(password authentication failed for user\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted user]");
  message = message.replace(/(\buser\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted user]");
  message = message.replace(/(\brole\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted user]");
  message = message.replace(/(\b(?:password|passwd|pwd)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted password]");
  // CLI diagnostics can contain credentials even when no database URL was
  // available to the redactor. Cover age identities, bearer credentials, and
  // the common token/key assignment forms before returning any error text.
  message = message.replace(/AGE-SECRET-KEY-[A-Za-z0-9]+/g, "[redacted age identity]");
  message = message.replace(/(\b(?:authorization\s*:\s*bearer|bearer)\s+)[^\s,;]+/gi, "$1[redacted token]");
  message = message.replace(/(\b(?:token|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|api[_-]?(?:key|token)|secret[_-]?(?:key|token)?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted token]");
  message = message.replace(/(--(?:token|access-token|refresh-token|auth-token|api-key|api-token)(?:=|\s+))[^\s,;]+/gi, "$1[redacted token]");
  // JWTs are commonly printed without a field name by HTTP/client errors.
  message = message.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]");
  for (const value of [...credentialValues].sort((a, b) => b.length - a.length)) message = message.split(value).join("[redacted credential]");
  return message;
}

export async function readPostgresTarget(pool: Pool): Promise<{ database: string; schema: string | null }> {
  const result = await pool.query<{ database: string; schema: string | null }>("SELECT current_database() AS database, current_schema() AS schema");
  const target = result.rows[0];
  if (!target) throw new Error("PostgreSQL connection returned no target identity");
  return target;
}

function safeTargetPart(value: string | null): string {
  return value === null ? "(none)" : value.replace(/[\u0000-\u001f\u007f]/g, "?");
}

type FileFingerprint = { exists: boolean; size: number; mtimeMs: number; sha256: string | null };
function fingerprint(file: string): FileFingerprint {
  try {
    const stat = statSync(file);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  } catch { return { exists: false, size: 0, mtimeMs: 0, sha256: null }; }
}
function sqliteFileFingerprints(dbFile: string): Record<string, FileFingerprint> {
  return Object.fromEntries([dbFile, `${dbFile}-wal`, `${dbFile}-shm`].map((file) => [file, fingerprint(file)]));
}
function assertUnchanged(before: Record<string, FileFingerprint>, dbFile: string): void {
  const after = sqliteFileFingerprints(dbFile);
  for (const file of Object.keys(before)) if (JSON.stringify(before[file]) !== JSON.stringify(after[file])) throw new Error(`SQLite read-only target changed unexpectedly (DB/WAL/SHM): ${file}`);
}

function openReadonlySnapshot(dbFile: string): { db: DatabaseSync; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-migrate-readonly-"));
  const copy = path.join(directory, "snapshot.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbFile}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${copy}${suffix}`);
  }
  const db = new DatabaseSync(copy, { timeout: 5000, readOnly: true, enableForeignKeyConstraints: true });
  return { db, cleanup: () => { try { db.close(); } finally { rmSync(directory, { recursive: true, force: true }); } } };
}

export interface PreMigrationApplyOperations<B> {
  readonly createBackup: () => Promise<B>;
  readonly verifyBackup: (backup: B) => PublishedBackupVerification;
  readonly applyMigration: () => Promise<MigrationRunResult>;
  readonly verifyMigration: () => Promise<MigrationRunResult>;
}

export interface PreMigrationApplyOptions {
  /** Bounded per-stage budgets; defaults to APPLY_STAGE_BUDGET_MS. */
  readonly stageTimeoutMs?: Partial<Record<keyof typeof APPLY_STAGE_BUDGET_MS, number>>;
  /** Stage progress reporter: the CLI prints which external step is running. */
  readonly onStage?: StageReporter;
}

/** Shared ordering boundary: no migration or success result exists before a verified pre-backup. */
function assertHeadApplyResult(result: MigrationRunResult): void {
  if (result.mode !== "apply" || result.status !== "applied" || result.pending.length !== 0 || result.appliedVersion === null) {
    throw new Error("migration apply did not reach the migration head; pre-migration backup retained");
  }
}

function assertHeadVerification(result: MigrationRunResult, appliedVersion: number): void {
  if (result.mode !== "verify" || result.status !== "verified" || result.pending.length !== 0 || result.appliedVersion !== appliedVersion) {
    throw new Error("post-migration verification did not confirm the migration head; pre-migration backup retained");
  }
}

export async function applyWithPreMigrationBackup<B>(
  operations: PreMigrationApplyOperations<B>,
  options: PreMigrationApplyOptions = {},
): Promise<{
  readonly backup: PublishedBackupVerification;
  readonly migration: MigrationRunResult;
  readonly verification: MigrationRunResult;
}> {
  const report = options.onStage;
  const budgets = { ...APPLY_STAGE_BUDGET_MS, ...options.stageTimeoutMs };
  // Strict backup -> apply -> verify with a hard budget per step. A timeout is a
  // fail-closed abort named by stage; no success result is ever emitted. The
  // backup stage aborts its hung age child and waits for the confirmed settle;
  // migration stages are non-cancellable and never return a timeout result
  // while the migration is still running.
  const backup = await withStageTimeout("backup", budgets.backup, operations.createBackup, { abort: () => abortActiveAgeChild() }, report);
  const verifiedBackup = await withStageTimeout("backup-verify", budgets.backupVerify, () => Promise.resolve(operations.verifyBackup(backup)), undefined, report);
  const migration = await withStageTimeout("migration-apply", budgets.migrationApply, operations.applyMigration, undefined, report);
  // Never emit a success result for a runner that reports a partial apply.
  assertHeadApplyResult(migration);
  const appliedVersion = migration.appliedVersion;
  if (appliedVersion === null) throw new Error("migration apply did not reach the migration head; pre-migration backup retained");
  const verification = await withStageTimeout("migration-verify", budgets.migrationVerify, operations.verifyMigration, undefined, report);
  assertHeadVerification(verification, appliedVersion);
  return { backup: verifiedBackup, migration, verification };
}

function machineResult(dialect: "SQLite" | "PostgreSQL", result: Awaited<ReturnType<typeof applyWithPreMigrationBackup<BackupResult | PostgresBackupResult>>>): string {
  return JSON.stringify({
    status: "success",
    mode: "apply",
    dialect,
    backup: {
      id: result.backup.id,
      kind: result.backup.kind,
      checksum: result.backup.checksum,
      version: result.backup.version,
    },
    migration: {
      mode: result.migration.mode,
      status: result.migration.status,
      appliedVersion: result.migration.appliedVersion,
      pending: result.migration.pending.length,
    },
    verify: {
      mode: result.verification.mode,
      status: result.verification.status,
      appliedVersion: result.verification.appliedVersion,
      pending: result.verification.pending.length,
    },
  });
}

async function main(): Promise<void> {
  const cli = parseMigrateArgs(process.argv.slice(2));
  const environment = process.env as StorageEnvironment;
  validateMigrationCliPathValues(environment);

  if (environment.PI_STORAGE_DIALECT?.trim().toLowerCase() === "postgres") {
    const storage = resolveStorageConfig({}, "", environment);
    if (storage.dialect !== "postgres") throw new Error("migration CLI dialect resolution failed safely");
    if (cli.mode === "apply") {
      const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
      // The gate pool is bounded so a hung query cannot leak a connection.
      const pool = createPostgresPool(storage.databaseUrl, {
        connectionTimeoutMillis: 5_000,
        statementTimeoutMs: APPLY_STAGE_BUDGET_MS.migrationApply,
        queryTimeoutMs: APPLY_STAGE_BUDGET_MS.migrationApply,
      });
      const kysely = createPostgresKysely(pool);
      const report: StageReporter = (stage, state) => console.log(`[migrate:apply] stage=${stage} state=${state}`);
      try {
        const target = await readPostgresTarget(pool);
        console.log(`migration target: ${summarizePostgresTarget(storage.databaseUrl)}; effective schema=${safeTargetPart(target.schema)} (maintenance confirmation is operator-provided; no process lock)`);
        const operations: PreMigrationApplyOperations<PostgresBackupResult> = {
          createBackup: () => createPostgresBackup({
            storageDialect: "postgres", databaseUrl: storage.databaseUrl,
            paths: { dataDir: paths.dataDir, agentDir: paths.agentDir, backupRoot: paths.backupRoot, ageRecipientFile: paths.ageRecipientFile },
            backupKind: "pre-migration",
            stagingRoot: environment.PI_BACKUP_STAGING_ROOT,
            onStage: report,
          }),
          verifyBackup: (backup) => verifyPublishedBackup(backup),
          applyMigration: () => runPostgresMigrations(kysely, { mode: "apply" }),
          verifyMigration: () => runPostgresMigrations(kysely, { mode: "verify" }),
        };
        console.log(machineResult("PostgreSQL", await applyWithPreMigrationBackup(operations, { onStage: report })));
      } finally { await kysely.destroy(); }
      return;
    }
    const pool = createPostgresPool(storage.databaseUrl);
    const kysely = createPostgresKysely(pool);
    try {
      const target = await readPostgresTarget(pool);
      console.log(`migration target: ${summarizePostgresTarget(storage.databaseUrl)}; effective schema=${safeTargetPart(target.schema)} (read-only inspection; no writes)`);
      printResult(await runPostgresMigrations(kysely, { mode: cli.mode }));
    } finally { await kysely.destroy(); }
    return;
  }

  const paths = resolveMigrationCliPaths(environment, environment.AGENT_CWD!);
  const storage = resolveStorageConfig({}, paths.dbPath, environment);
  if (storage.dialect !== "sqlite") throw new Error("migration CLI dialect resolution failed safely");
  const dbFile = path.resolve(storage.dbPath);
  console.log(`migration target: SQLite ${dbFile} (${cli.mode === "apply" ? "will inspect and migrate this database; maintenance confirmation is operator-provided, not a process lock" : "read-only inspection; no writes"})`);
  if (cli.mode !== "apply" && !existsSync(dbFile)) throw new Error(`SQLite target does not exist; ${cli.mode} failed without creating it: ${dbFile}`);

  if (cli.mode === "apply") {
    const backupPaths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
    const operations: PreMigrationApplyOperations<BackupResult> = {
      createBackup: () => createSqliteBackup({ paths: backupPaths, backupKind: "pre-migration", stagingRoot: environment.PI_BACKUP_STAGING_ROOT }),
      verifyBackup: (backup) => verifyPublishedBackup(backup),
      applyMigration: async () => {
        const db = new DatabaseSync(dbFile, { timeout: 5000, enableForeignKeyConstraints: true });
        try { db.exec("PRAGMA journal_mode=WAL"); return await runSqliteMigrations(db, { mode: "apply" }); }
        finally { db.close(); }
      },
      verifyMigration: async () => {
        const before = sqliteFileFingerprints(dbFile);
        const snapshot = openReadonlySnapshot(dbFile);
        try { return await runSqliteMigrations(snapshot.db, { mode: "verify" }); }
        finally { snapshot.cleanup(); assertUnchanged(before, dbFile); }
      },
    };
    console.log(machineResult("SQLite", await applyWithPreMigrationBackup(operations)));
    return;
  }

  const before = sqliteFileFingerprints(dbFile);
  const snapshot = openReadonlySnapshot(dbFile);
  try { printResult(await runSqliteMigrations(snapshot.db, { mode: cli.mode })); }
  finally { snapshot.cleanup(); assertUnchanged(before, dbFile); }
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  void main().catch((error: unknown) => {
    console.error(`[migrate] ${redactedMessage(error, process.env.PI_DATABASE_URL?.trim())}`);
    process.exitCode = error instanceof Error && error.message.startsWith("用法：") ? 2 : 1;
  });
}
