#!/usr/bin/env node
// Mandatory WP3C gate. It never skips: URL, age, pg_dump/pg_restore, and
// matching client/server majors are prerequisites for the isolated real test.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { parseServerVersionNumMajor } from "../src/backup/postgres-backup-core.js";
import { checkPgBackupBinaries, readPgBackupClientVersions, resolveBinPath } from "./test-pg-backup.js";
import { PG_TEST_REQUIRED_ENV, runVitestWithEvidence } from "./pg-test-gate.js";

export const MIGRATION_PREBACKUP_URL_ENV = "PI_TEST_PG_URL";
export const MIGRATION_PREBACKUP_TEST_FILE = "tests/postgres/migration-prebackup.test.ts";
export { PG_TEST_REQUIRED_ENV };

export function resolveMigrationPrebackupUrl(raw: string | undefined): { ok: boolean; reason?: string } {
  return typeof raw === "string" && raw.trim() !== ""
    ? { ok: true }
    : { ok: false, reason: `[test:migration-prebackup] ${MIGRATION_PREBACKUP_URL_ENV} 未配置或为空白：真实 WP3C PG pre-migration backup 门禁未执行；连接串不打印。` };
}

async function serverMajor(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query("SHOW server_version_num");
    return parseServerVersionNumMajor(result.rows[0]?.server_version_num);
  } finally { await pool.end().catch(() => undefined); }
}

async function main(): Promise<void> {
  const url = resolveMigrationPrebackupUrl(process.env[MIGRATION_PREBACKUP_URL_ENV]);
  if (!url.ok) { console.error(url.reason); process.exitCode = 1; return; }
  const binaries = checkPgBackupBinaries();
  if (!binaries.ok) { console.error(`[test:migration-prebackup] ${binaries.reason}; 未执行真实 pre-migration backup。`); process.exitCode = 1; return; }
  const versions = readPgBackupClientVersions();
  if (!("pgDumpMajor" in versions)) { console.error(`[test:migration-prebackup] ${versions.reason}`); process.exitCode = 1; return; }
  let major: number;
  try { major = await serverMajor(process.env[MIGRATION_PREBACKUP_URL_ENV]!.trim()); }
  catch { console.error("[test:migration-prebackup] 无法查询 PostgreSQL server major；门禁拒绝通过；连接串不打印。"); process.exitCode = 1; return; }
  if (versions.pgDumpMajor !== versions.pgRestoreMajor || versions.pgDumpMajor !== major) {
    console.error(`[test:migration-prebackup] PostgreSQL client/server major mismatch: pg_dump ${versions.pgDumpMajor}, pg_restore ${versions.pgRestoreMajor}, server ${major}; install matching client。`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runVitestWithEvidence({
    vitestPath: resolveBinPath("vitest", "vitest"),
    target: MIGRATION_PREBACKUP_TEST_FILE,
    scope: "test:migration-prebackup",
    env: { ...process.env, [MIGRATION_PREBACKUP_URL_ENV]: process.env[MIGRATION_PREBACKUP_URL_ENV]!.trim(), [PG_TEST_REQUIRED_ENV]: "1" },
  });
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) void main();
