// Mandatory WP3B2 gate. Unlike ordinary `pnpm test`, this command never skips:
// it requires PI_TEST_PG_URL and both pg_dump/pg_restore binaries, then runs the
// isolated PostgreSQL backup/restore test file. The URL is passed only through
// the child environment and is never printed.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { checkRequiredPgTools, probePgBinary, PG_TEST_REQUIRED_ENV, runVitestWithEvidence } from "./pg-test-gate.js";
import { realpathSync } from "node:fs";
import { Pool } from "pg";
import { parseClientMajor, parseServerVersionNumMajor, parseVersion } from "../src/backup/postgres-backup-core.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export const PG_BACKUP_URL_ENV = "PI_TEST_PG_URL";
export const PG_BACKUP_TEST_FILE = "tests/postgres/pg-backup.test.ts";
export { PG_TEST_REQUIRED_ENV };

export interface PgBackupGateDecision {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface PgBackupClientVersions {
  readonly pgDumpVersion: string;
  readonly pgRestoreVersion: string;
  readonly pgDumpMajor: number;
  readonly pgRestoreMajor: number;
}

export function resolvePgBackupUrl(raw: string | undefined): PgBackupGateDecision {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      reason: `[test:pg-backup] ${PG_BACKUP_URL_ENV} 未配置或为空白：真实 PostgreSQL pg_dump/pg_restore 备份恢复门禁未执行；请配置隔离测试 PG 后重试。连接串不打印。`,
    };
  }
  return { ok: true };
}

export type PgBackupBinaryProbe = (binary: string) => boolean;

/** Exported for unit tests: presence accepts either --version or -h. */
export function probePgBackupBinary(
  binary: string,
  run?: (binary: string, args: readonly string[]) => number | null,
): boolean {
  return run ? probePgBinary(binary, run) : probePgBinary(binary);
}

export function checkPgBackupBinaries(probe: PgBackupBinaryProbe = probePgBackupBinary): PgBackupGateDecision {
  const decision = checkRequiredPgTools(probe);
  return decision.ok
    ? { ok: true }
    : { ok: false, reason: `[test:pg-backup] ${decision.reason} 未执行真实 dump/restore。` };
}

type PgBackupVersionProbe = (command: "pg_dump" | "pg_restore") => Buffer;

function probePgBackupVersion(command: "pg_dump" | "pg_restore"): Buffer {
  for (const args of [["--version"], ["-h"]] as const) {
    try {
      const result = spawnSync(command, args, { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0) {
        const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
        const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
        return Buffer.concat([stdout, stderr]);
      }
    } catch { /* try the alternate probe */ }
  }
  return Buffer.alloc(0);
}

export function readPgBackupClientVersions(probe: PgBackupVersionProbe = probePgBackupVersion): PgBackupClientVersions | PgBackupGateDecision {
  try {
    const pgDumpVersion = parseVersion("pg_dump", probe("pg_dump"));
    const pgRestoreVersion = parseVersion("pg_restore", probe("pg_restore"));
    return { pgDumpVersion, pgRestoreVersion, pgDumpMajor: parseClientMajor(pgDumpVersion), pgRestoreMajor: parseClientMajor(pgRestoreVersion) };
  } catch {
    return { ok: false, reason: "[test:pg-backup] pg_dump/pg_restore 版本输出无法安全解析；真实 PostgreSQL backup/restore 门禁拒绝通过；未执行真实 dump/restore。" };
  }
}

export function checkPgBackupClientMajorCompatibility(
  versions: Pick<PgBackupClientVersions, "pgDumpMajor" | "pgRestoreMajor">,
  serverMajor: number,
): PgBackupGateDecision {
  if (versions.pgDumpMajor !== versions.pgRestoreMajor) {
    return { ok: false, reason: `[test:pg-backup] PostgreSQL pg_dump/pg_restore major mismatch: pg_dump client major ${versions.pgDumpMajor}, pg_restore client major ${versions.pgRestoreMajor}; install matching client。` };
  }
  if (versions.pgDumpMajor !== serverMajor) {
    return { ok: false, reason: `[test:pg-backup] PostgreSQL client/server major mismatch: client major ${versions.pgDumpMajor}, server major ${serverMajor}; install matching client。` };
  }
  return { ok: true };
}

async function queryGateServerMajor(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query("SHOW server_version_num");
    return parseServerVersionNumMajor(result.rows[0]?.server_version_num);
  } catch {
    throw new Error("[test:pg-backup] 无法安全查询 PostgreSQL server major；真实 backup/restore 门禁拒绝通过；未执行真实 dump/restore。连接串不打印。");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export function resolveBinPath(packageName: string, binKey: string): string {
  let packageJson: string;
  try { packageJson = require.resolve(`${packageName}/package.json`); }
  catch { throw new Error(`[test:pg-backup] 找不到依赖 '${packageName}'`); }
  const pkg = require(packageJson) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binKey];
  if (!bin) throw new Error(`[test:pg-backup] 依赖 '${packageName}' 没有可执行入口`);
  return join(dirname(packageJson), bin);
}

export function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

async function main(): Promise<void> {
  const url = resolvePgBackupUrl(process.env[PG_BACKUP_URL_ENV]);
  if (!url.ok) { console.error(url.reason); process.exitCode = 1; return; }
  const binaries = checkPgBackupBinaries();
  if (!binaries.ok) { console.error(binaries.reason); process.exitCode = 1; return; }
  const versions = readPgBackupClientVersions();
  if (!("pgDumpMajor" in versions)) { console.error(versions.reason); process.exitCode = 1; return; }
  let serverMajor: number;
  try { serverMajor = await queryGateServerMajor(process.env[PG_BACKUP_URL_ENV]!.trim()); }
  catch (error) { console.error(error instanceof Error ? error.message : "[test:pg-backup] PostgreSQL server preflight failed"); process.exitCode = 1; return; }
  const compatibility = checkPgBackupClientMajorCompatibility(versions, serverMajor);
  if (!compatibility.ok) { console.error(compatibility.reason); process.exitCode = 1; return; }
  process.exitCode = await runVitestWithEvidence({
    vitestPath: resolveBinPath("vitest", "vitest"),
    target: PG_BACKUP_TEST_FILE,
    scope: "test:pg-backup",
    env: { ...process.env, [PG_BACKUP_URL_ENV]: process.env[PG_BACKUP_URL_ENV]!.trim(), [PG_TEST_REQUIRED_ENV]: "1" },
  });
}

if (isCliEntry()) void main();
