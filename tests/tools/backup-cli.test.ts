import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBackupArgs, redactMessage } from "../../scripts/backup.js";
import { resolveBackupCliPaths } from "../../src/storage/storage-config.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("offline backup CLI", () => {
  it("requires create, absolute AGENT_CWD, backup root and recipient file", () => {
    expect(() => parseBackupArgs([])).toThrow(/用法/);
    expect(() => parseBackupArgs(["create", "--backup-root", "/tmp/x"])).toThrow(/recipient/);
    expect(() => resolveBackupCliPaths({ AGENT_CWD: "relative" }, "/tmp/backup", "/tmp/recipient")).toThrow(/absolute AGENT_CWD/);
    expect(() => resolveBackupCliPaths({ AGENT_CWD: "/workspace" }, "relative", "/tmp/recipient")).toThrow(/absolute --backup-root/);
    expect(() => resolveBackupCliPaths({ AGENT_CWD: "/workspace" }, "/tmp/backup", "relative")).toThrow(/absolute --age-recipient-file/);
  });

  it("dry-run does not create backup root and does not require a system age binary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-test-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sample (value TEXT)");
    db.close();
    const backupRoot = path.join(root, "backup-root");
    const recipient = path.join(root, "recipient.txt");
    writeFileSync(recipient, "age1clitest\n", { mode: 0o600 });
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient, "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run: no writes");
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("selects the PostgreSQL backup core and redacts credentials on failure", () => {
    const url = "postgres://cli-user:cli-password@example.test/private";
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", "/tmp/pi-backup-cli", "--age-recipient-file", "/tmp/recipient"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_CWD: process.cwd(), PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: url, PI_AUTH_PATH: "/private/auth-with-secret.json" },
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/backup:|\[backup\]/);
    expect(output).not.toContain(url);
    expect(output).not.toContain("cli-user");
    expect(output).not.toContain("cli-password");
    expect(output).not.toContain("auth-with-secret.json");
    expect(redactMessage(new Error(`failed ${url}`))).not.toContain("cli-password");
  });

  it("rejects a relative or blank PI_BACKUP_STAGING_ROOT through the real CLI", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-staging-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sample (value TEXT)");
    db.close();
    const backupRoot = path.join(root, "backup-root");
    const recipient = path.join(root, "recipient.txt");
    writeFileSync(recipient, "age1clitest\n", { mode: 0o600 });
    const run = (stagingRoot: string) => spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient, "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_BACKUP_STAGING_ROOT: stagingRoot },
      encoding: "utf8",
    });
    const relative = run("relative/staging");
    expect(relative.status).not.toBe(0);
    expect(`${relative.stdout}${relative.stderr}`).toMatch(/staging root must be an absolute path/);
    const blank = run("   ");
    expect(blank.status).not.toBe(0);
    expect(`${blank.stdout}${blank.stderr}`).toMatch(/staging root must be a non-blank string/);
    // Neither run materialized a backup root.
    expect(existsSync(backupRoot)).toBe(false);
  });
});
