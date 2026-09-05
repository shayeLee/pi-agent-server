#!/usr/bin/env node
// Mandatory WP5D-4 real-PostgreSQL owner-transfer gate. It never skips: URL, age,
// pg_dump/pg_restore, and matching client/server majors are prerequisites for the
// isolated random-schema drill. The fixture creates and drops only its own random
// business schema; no real user database is ever touched.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { parseServerVersionNumMajor } from "../src/backup/postgres-backup-core.js";
import { checkPgBackupBinaries, readPgBackupClientVersions, resolveBinPath } from "./test-pg-backup.js";
import { runVitestWithEvidence } from "./pg-test-gate.js";

export const OWNER_TRANSFER_PG_URL_ENV = "PI_TEST_PG_URL";
export const OWNER_TRANSFER_PG_TEST_FILE = "tests/postgres/owner-transfer-pg";

export function resolveOwnerTransferPgUrl(raw: string | undefined): { ok: boolean; reason?: string } {
  return typeof raw === "string" && raw.trim() !== ""
    ? { ok: true }
    : { ok: false, reason: `[test:owner-transfer-pg] ${OWNER_TRANSFER_PG_URL_ENV} 未配置或为空白：真实 WP5D-4 PG owner-transfer 门禁未执行；连接串不打印。` };
}

async function serverMajor(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query("SHOW server_version_num");
    return parseServerVersionNumMajor(result.rows[0]?.server_version_num);
  } finally { await pool.end().catch(() => undefined); }
}

async function main(): Promise<void> {
  const url = resolveOwnerTransferPgUrl(process.env[OWNER_TRANSFER_PG_URL_ENV]);
  if (!url.ok) { console.error(url.reason); process.exitCode = 1; return; }
  const binaries = checkPgBackupBinaries();
  if (!binaries.ok) { console.error(`[test:owner-transfer-pg] ${binaries.reason}; 未执行真实 owner-transfer 演练。`); process.exitCode = 1; return; }
  const versions = readPgBackupClientVersions();
  if (!("pgDumpMajor" in versions)) { console.error(`[test:owner-transfer-pg] ${versions.reason}`); process.exitCode = 1; return; }
  let major: number;
  try { major = await serverMajor(process.env[OWNER_TRANSFER_PG_URL_ENV]!.trim()); }
  catch { console.error("[test:owner-transfer-pg] 无法查询 PostgreSQL server major；门禁拒绝通过；连接串不打印。"); process.exitCode = 1; return; }
  if (versions.pgDumpMajor !== versions.pgRestoreMajor || versions.pgDumpMajor !== major) {
    console.error(`[test:owner-transfer-pg] PostgreSQL client/server major mismatch: pg_dump ${versions.pgDumpMajor}, pg_restore ${versions.pgRestoreMajor}, server ${major}; install matching client。`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runVitestWithEvidence({
    vitestPath: resolveBinPath("vitest", "vitest"),
    target: OWNER_TRANSFER_PG_TEST_FILE,
    scope: "test:owner-transfer-pg",
    env: { ...process.env, [OWNER_TRANSFER_PG_URL_ENV]: process.env[OWNER_TRANSFER_PG_URL_ENV]!.trim(), PI_TEST_PG_REQUIRED: "1" },
  });
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) void main();