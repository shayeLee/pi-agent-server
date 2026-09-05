import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { PG_BACKUP_TEST_FILE, PG_BACKUP_URL_ENV, checkPgBackupBinaries, checkPgBackupClientMajorCompatibility, probePgBackupBinary, readPgBackupClientVersions, resolvePgBackupUrl } from "../../scripts/test-pg-backup.js";

describe("test:pg-backup mandatory gate", () => {
  it("rejects a missing/blank URL without leaking a connection string", () => {
    expect(resolvePgBackupUrl(undefined).ok).toBe(false);
    expect(resolvePgBackupUrl("  \n").reason).toContain(PG_BACKUP_URL_ENV);
    expect(resolvePgBackupUrl(" ").reason).not.toContain("postgresql://");
  });

  it("fails closed when the injected binary probe reports missing tools", () => {
    const decision = checkPgBackupBinaries(() => false);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/pg_dump|pg_restore/);
  });

  it("accepts an injected present-tool probe without depending on host binaries", () => {
    expect(checkPgBackupBinaries(() => true)).toEqual({ ok: true });
  });

  it("covers --version/-h probe disagreement instead of treating one probe as authoritative", () => {
    expect(probePgBackupBinary("pg_dump", (_binary, args) => args[0] === "--version" ? 1 : 0)).toBe(true);
    expect(probePgBackupBinary("pg_dump", (_binary, args) => args[0] === "--version" ? 0 : 1)).toBe(true);
    expect(probePgBackupBinary("pg_dump", () => 1)).toBe(false);
  });

  it("parses mocked tool versions and rejects malformed output without host binaries", () => {
    const versions = readPgBackupClientVersions((command) => Buffer.from(`${command} (PostgreSQL) 16.4\n`));
    expect(versions).toMatchObject({ pgDumpVersion: "16.4", pgRestoreVersion: "16.4", pgDumpMajor: 16, pgRestoreMajor: 16 });
    expect(readPgBackupClientVersions(() => Buffer.from("not a PostgreSQL version\n"))).toMatchObject({ ok: false });
  });

  it("fails the real gate closed for tool/server major mismatches before vitest", () => {
    expect(checkPgBackupClientMajorCompatibility({ pgDumpMajor: 16, pgRestoreMajor: 16 }, 16)).toEqual({ ok: true });
    expect(checkPgBackupClientMajorCompatibility({ pgDumpMajor: 16, pgRestoreMajor: 17 }, 16).reason).toMatch(/pg_dump\/pg_restore major mismatch/);
    expect(checkPgBackupClientMajorCompatibility({ pgDumpMajor: 18, pgRestoreMajor: 18 }, 16).reason).toMatch(/client major 18, server major 16.*install matching client/);
  });

  it("runs only the dedicated real backup/restore test file", () => {
    expect(PG_BACKUP_TEST_FILE).toBe("tests/postgres/pg-backup.test.ts");
  });

  it("the runner CLI fails closed with a missing gate URL and claims no acceptance", () => {
    const env = { ...process.env };
    delete env[PG_BACKUP_URL_ENV];
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/test-pg-backup.ts"], { cwd: process.cwd(), env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(PG_BACKUP_URL_ENV);
    // 门禁未执行：不存在任何成功/通过/验收断言（不称过）。
    expect(output).toMatch(/未执行/);
    expect(output).not.toMatch(/passed|accepted|验收通过|门禁通过/);
  });
});
