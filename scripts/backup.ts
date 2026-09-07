#!/usr/bin/env node
// WP3A SQLite / WP3B2 PostgreSQL offline backup tool. It is deliberately not imported by startServer
// and does not install a timer or scheduler.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSqliteBackup } from "../src/backup/backup-core.js";
import { createPostgresBackup, redactPgDiagnostic } from "../src/backup/postgres-backup-core.js";
import { resolveBackupCliPaths, resolveStorageConfig, type StorageEnvironment } from "../src/storage/storage-config.js";

export interface BackupCliOptions {
  readonly dryRun: boolean;
  readonly backupRoot: string;
  readonly ageRecipientFile: string;
}

/**
 * Stable machine-readable success contract for the WP5C Option B deployment
 * contract (helpers/timers; see docs/backup-freshness-exporter.md).
 * `--dry-run` is subject to the same source-ledger gate and emits no success
 * line. A missing/legacy/multi-row/checksum-mismatched ledger therefore exits
 * non-zero before encryption/publication and cannot advance freshness.
 *
 * Missing session
 * references are missing-as-empty: they are counted in the report and never
 * block publication. External automation may treat (exit 0 + exactly one such
 * line with status=published/dryRun=false and a finalPath inside BACKUP_ROOT)
 * as the only freshness advancement.
 */
export const BACKUP_MACHINE_REPORT_PREFIX = "backup-json-report";

export function backupMachineReportLine(dialect: "sqlite" | "postgres", result: { readonly finalPath: string | null; readonly files: readonly unknown[]; readonly missingSessionReferences: readonly unknown[] }): string | null {
  if (!result.finalPath) return null;
  return `${BACKUP_MACHINE_REPORT_PREFIX}: ${JSON.stringify({
    dialect,
    status: "published",
    dryRun: false,
    finalPath: result.finalPath,
    payloadCount: result.files.length,
    missingSessionReferences: result.missingSessionReferences.length,
  })}`;
}

export function parseBackupArgs(args: readonly string[]): BackupCliOptions {
  const actual = args[0] === "--" ? args.slice(1) : args;
  if (actual.length === 0 || actual[0] !== "create") {
    throw new Error("用法：pnpm backup -- create --backup-root ABSOLUTE_DIR --age-recipient-file ABSOLUTE_FILE [--dry-run]");
  }
  let dryRun = false;
  let backupRoot: string | undefined;
  let ageRecipientFile: string | undefined;
  for (let index = 1; index < actual.length; index++) {
    const arg = actual[index];
    if (arg === "--dry-run") {
      if (dryRun) throw new Error("用法：--dry-run 只能出现一次");
      dryRun = true;
    } else if (arg === "--backup-root") {
      if (backupRoot !== undefined || !actual[index + 1]) throw new Error("用法：需要一个 --backup-root 绝对路径");
      backupRoot = actual[++index];
    } else if (arg === "--age-recipient-file") {
      if (ageRecipientFile !== undefined || !actual[index + 1]) throw new Error("用法：需要一个 --age-recipient-file 绝对路径");
      ageRecipientFile = actual[++index];
    } else {
      throw new Error(`用法：未知参数 ${arg}`);
    }
  }
  if (!backupRoot || !ageRecipientFile) throw new Error("用法：--backup-root 与 --age-recipient-file 都是必需的");
  return { dryRun, backupRoot, ageRecipientFile };
}

function redactMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = [
    process.env.PI_DATABASE_URL,
    process.env.PI_AUTH_PATH,
    process.env.PI_MODEL_API_KEY,
    process.env.PGPASSWORD,
    process.env.PGUSER,
    process.env.PGPASSFILE,
  ].filter((value): value is string => Boolean(value));
  return redactPgDiagnostic(message, secrets);
}

async function main(): Promise<void> {
  const cli = parseBackupArgs(process.argv.slice(2));
  const environment = process.env as StorageEnvironment;
  const paths = resolveBackupCliPaths(environment, cli.backupRoot, cli.ageRecipientFile, environment.AGENT_CWD!);
  const storage = resolveStorageConfig({}, paths.dbPath, environment);
  if (storage.dialect === "postgres") {
    const dialect = environment.PI_STORAGE_DIALECT?.trim().toLowerCase();
    if (dialect !== "postgres" || !environment.PI_DATABASE_URL?.trim()) throw new Error("backup: PostgreSQL backup requires explicit PI_STORAGE_DIALECT=postgres and PI_DATABASE_URL");
    const result = await createPostgresBackup({
      storageDialect: dialect,
      databaseUrl: storage.databaseUrl,
      paths: { dataDir: paths.dataDir, agentDir: paths.agentDir, authPath: paths.authPath, backupRoot: paths.backupRoot, ageRecipientFile: paths.ageRecipientFile },
      dryRun: cli.dryRun,
      stagingRoot: environment.PI_BACKUP_STAGING_ROOT,
    });
    if (result.dryRun) console.log(`backup dry-run: no writes; ${result.files.length} whitelisted payload(s), ${result.missingSessionReferences.length} missing session reference(s)`);
    else {
      console.log(`backup created: ${result.finalPath}; ${result.files.length} encrypted payload(s), ${result.missingSessionReferences.length} missing session reference(s)`);
      const machine = backupMachineReportLine("postgres", result);
      if (machine) console.log(machine);
    }
    return;
  }
  const result = await createSqliteBackup({ paths, dryRun: cli.dryRun, stagingRoot: environment.PI_BACKUP_STAGING_ROOT });
  if (result.dryRun) {
    console.log(`backup dry-run: no writes; ${result.files.length} whitelisted payload(s), ${result.missingSessionReferences.length} missing session reference(s)`);
  } else {
    console.log(`backup created: ${result.finalPath}; ${result.files.length} encrypted payload(s), ${result.missingSessionReferences.length} missing session reference(s)`);
    if (result.missingSessionReferences.length > 0) console.log("backup note: missing session references are recorded in the encrypted manifest and were not included (missing-as-empty)");
    const machine = backupMachineReportLine("sqlite", result);
    if (machine) console.log(machine);
  }
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  void main().catch((error: unknown) => {
    console.error(`[backup] ${redactMessage(error)}`);
    process.exitCode = error instanceof Error && error.message.startsWith("用法：") ? 2 : 1;
  });
}

export { redactMessage };
