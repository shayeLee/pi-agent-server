#!/usr/bin/env node
// WP3B1 SQLite / WP3B2 PostgreSQL offline restore drill. It never starts the service or a model runtime.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { POSTGRES_RESTORE_SAFETY_CONTRACT, restorePostgresBackup, restoreSqliteBackup, type RestorePaths } from "../src/backup/restore-core.js";

export interface RestoreCliOptions {
  readonly dryRun: boolean;
  readonly inputBackup: string;
  readonly targetRoot: string;
  readonly ageIdentityFile: string;
  readonly targetPgUrl?: string;
}

const usage = "用法：pnpm restore -- restore --input-backup ABSOLUTE_DIR --target-root ABSOLUTE_DIR --age-identity-file ABSOLUTE_FILE [--target-pg-url EXPLICIT_URL] [--dry-run]";

export function parseRestoreArgs(args: readonly string[]): RestoreCliOptions {
  const actual = args[0] === "--" ? args.slice(1) : args;
  if (actual.length === 0 || actual[0] !== "restore") throw new Error(usage);
  let dryRun = false;
  let inputBackup: string | undefined;
  let targetRoot: string | undefined;
  let ageIdentityFile: string | undefined;
  let targetPgUrl: string | undefined;
  for (let index = 1; index < actual.length; index++) {
    const argument = actual[index];
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("用法：--dry-run 只能出现一次");
      dryRun = true;
    } else if (argument === "--input-backup") {
      if (inputBackup !== undefined || !actual[index + 1]) throw new Error("用法：需要一个 --input-backup 绝对路径");
      inputBackup = actual[++index];
    } else if (argument === "--target-root") {
      if (targetRoot !== undefined || !actual[index + 1]) throw new Error("用法：需要一个 --target-root 绝对路径");
      targetRoot = actual[++index];
    } else if (argument === "--age-identity-file") {
      if (ageIdentityFile !== undefined || !actual[index + 1]) throw new Error("用法：需要一个 --age-identity-file 绝对路径");
      ageIdentityFile = actual[++index];
    } else if (argument === "--target-pg-url") {
      if (targetPgUrl !== undefined || !actual[index + 1]) throw new Error("用法：需要一个显式临时 PostgreSQL target URL");
      targetPgUrl = actual[++index];
    } else {
      throw new Error("用法：未知参数");
    }
  }
  if (!inputBackup || !targetRoot || !ageIdentityFile) throw new Error("用法：--input-backup、--target-root 与 --age-identity-file 都是必需的");
  if (![inputBackup, targetRoot, ageIdentityFile].every((value) => path.isAbsolute(value))) throw new Error("用法：输入备份、目标根目录和 age identity 必须是绝对路径");
  return { dryRun, inputBackup, targetRoot, ageIdentityFile, targetPgUrl };
}

function redactRestoreMessage(error: unknown, _paths: readonly string[] = []): string {
  // Underlying restore errors may contain paths, SQLite/age diagnostics, or
  // identity details. The CLI deliberately exposes only a stable class.
  return error instanceof Error && error.message.startsWith("用法：")
    ? error.message
    : "restore error: RESTORE_FAILED";
}

async function main(): Promise<void> {
  const cli = parseRestoreArgs(process.argv.slice(2));
  const paths: RestorePaths = {
    inputBackup: cli.inputBackup,
    targetRoot: cli.targetRoot,
    ageIdentityFile: cli.ageIdentityFile,
  };
  if (cli.targetPgUrl !== undefined) {
    const result = await restorePostgresBackup({ paths, targetDatabaseUrl: cli.targetPgUrl, safetyContract: POSTGRES_RESTORE_SAFETY_CONTRACT, dryRun: cli.dryRun });
    console.log(JSON.stringify({ ...result.report, dryRun: result.dryRun }));
    return;
  }
  const result = await restoreSqliteBackup({ paths, dryRun: cli.dryRun });
  // Deliberately do not print finalPath: reports are safe to ship to an operator
  // and contain counts/version only, not cwd, credentials, URLs, or source paths.
  console.log(JSON.stringify({ ...result.report, dryRun: result.dryRun }));
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  void main().catch((error: unknown) => {
    console.error(`[restore] ${redactRestoreMessage(error)}`);
    process.exitCode = error instanceof Error && error.message.startsWith("用法：") ? 2 : 1;
  });
}

export { redactRestoreMessage };
