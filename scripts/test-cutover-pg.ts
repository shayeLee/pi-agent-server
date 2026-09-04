#!/usr/bin/env node
// Mandatory WP2A real-PostgreSQL cutover gate. It never skips: URL, age,
// pg_dump/pg_restore, and matching client/server majors are prerequisites for
// the isolated random-schema drill. The fixture creates and drops only its own
// random pi_cutover_* schema; no real user database is ever touched.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { parseServerVersionNumMajor } from "../src/backup/postgres-backup-core.js";
import { checkPgBackupBinaries, readPgBackupClientVersions, resolveBinPath } from "./test-pg-backup.js";
import { PG_TEST_REQUIRED_ENV, runVitestWithEvidence } from "./pg-test-gate.js";

export const CUTOVER_PG_URL_ENV = "PI_TEST_PG_URL";
/** 前缀过滤：同时匹配 tests/postgres/cutover-pg.test.ts 与 cutover-pg-cli.test.ts（库级 + 真实 CLI E2E）。 */
export const CUTOVER_PG_TEST_FILE = "tests/postgres/cutover-pg";
export { PG_TEST_REQUIRED_ENV };

export function resolveCutoverPgUrl(raw: string | undefined): { ok: boolean; reason?: string } {
  return typeof raw === "string" && raw.trim() !== ""
    ? { ok: true }
    : { ok: false, reason: `[test:cutover-pg] ${CUTOVER_PG_URL_ENV} 未配置或为空白：真实 WP2A PG cutover 门禁未执行；连接串不打印。` };
}

async function serverMajor(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query("SHOW server_version_num");
    return parseServerVersionNumMajor(result.rows[0]?.server_version_num);
  } finally { await pool.end().catch(() => undefined); }
}

async function main(): Promise<void> {
  const url = resolveCutoverPgUrl(process.env[CUTOVER_PG_URL_ENV]);
  if (!url.ok) { console.error(url.reason); process.exitCode = 1; return; }
  const binaries = checkPgBackupBinaries();
  if (!binaries.ok) { console.error(`[test:cutover-pg] ${binaries.reason}; 未执行真实 cutover 演练。`); process.exitCode = 1; return; }
  const versions = readPgBackupClientVersions();
  if (!("pgDumpMajor" in versions)) { console.error(`[test:cutover-pg] ${versions.reason}`); process.exitCode = 1; return; }
  let major: number;
  try { major = await serverMajor(process.env[CUTOVER_PG_URL_ENV]!.trim()); }
  catch { console.error("[test:cutover-pg] 无法查询 PostgreSQL server major；门禁拒绝通过；连接串不打印。"); process.exitCode = 1; return; }
  if (versions.pgDumpMajor !== versions.pgRestoreMajor || versions.pgDumpMajor !== major) {
    console.error(`[test:cutover-pg] PostgreSQL client/server major mismatch: pg_dump ${versions.pgDumpMajor}, pg_restore ${versions.pgRestoreMajor}, server ${major}; install matching client。`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runVitestWithEvidence({
    vitestPath: resolveBinPath("vitest", "vitest"),
    target: CUTOVER_PG_TEST_FILE,
    scope: "test:cutover-pg",
    env: { ...process.env, [CUTOVER_PG_URL_ENV]: process.env[CUTOVER_PG_URL_ENV]!.trim(), [PG_TEST_REQUIRED_ENV]: "1" },
  });
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) void main();
