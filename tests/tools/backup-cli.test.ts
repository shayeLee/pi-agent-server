import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBackupArgs, redactMessage, backupMachineReportLine, BACKUP_MACHINE_REPORT_PREFIX } from "../../scripts/backup.js";
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

  it("accepts the strict completeness flag exactly once and rejects unknown/duplicate flags fail-closed", () => {
    const parsed = parseBackupArgs(["create", "--backup-root", "/tmp/x", "--age-recipient-file", "/tmp/r", "--require-complete-session-references"]);
    expect(parsed.requireCompleteSessionReferences).toBe(true);
    expect(parsed.dryRun).toBe(false);
    expect(() => parseBackupArgs(["create", "--backup-root", "/tmp/x", "--age-recipient-file", "/tmp/r", "--require-complete-session-references", "--require-complete-session-references"])).toThrow(/用法/);
    // 拼写差异/未知参数一律 fail-closed。
    expect(() => parseBackupArgs(["create", "--backup-root", "/tmp/x", "--age-recipient-file", "/tmp/r", "--require-complete-session-reference"])).toThrow(/未知参数/);
    const withDryRun = parseBackupArgs(["create", "--backup-root", "/tmp/x", "--age-recipient-file", "/tmp/r", "--require-complete-session-references", "--dry-run"]);
    expect(withDryRun.requireCompleteSessionReferences).toBe(true);
    expect(withDryRun.dryRun).toBe(true);
  });

  it("emits the machine success line only for strict published success, never dry-run", () => {
    const line = backupMachineReportLine("sqlite", { finalPath: "/abs/backup-root/backup-1", files: [{ path: "a" }], missingSessionReferences: [] }, true);
    expect(line).toBe(`${BACKUP_MACHINE_REPORT_PREFIX}: {"dialect":"sqlite","status":"published","strict":true,"dryRun":false,"finalPath":"/abs/backup-root/backup-1","payloadCount":1,"missingSessionReferences":0}`);
    expect(backupMachineReportLine("postgres", { finalPath: "/abs/backup-root/backup-1", files: [], missingSessionReferences: [] }, true)).toMatch(/"dialect":"postgres"/);
    // dry-run（finalPath 为 null）与缺失引用都不能产生成功行；非 strict 调用同样不产生。
    expect(backupMachineReportLine("sqlite", { finalPath: null, files: [], missingSessionReferences: [] }, true)).toBeNull();
    expect(backupMachineReportLine("sqlite", { finalPath: "/abs/backup-root/backup-1", files: [], missingSessionReferences: [{ sessionId: "x", path: "y", status: "missing" }] }, true)).toBeNull();
    expect(backupMachineReportLine("sqlite", { finalPath: "/abs/backup-root/backup-1", files: [], missingSessionReferences: [] }, false)).toBeNull();
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

  it("strict completeness fails closed through the real CLI (source), with no machine success line", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-strict-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, pi_session_file TEXT)");
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("missing-cli-session", path.join(dataDir, "sessions", "gone", "history.jsonl"));
    db.close();
    const backupRoot = path.join(root, "backup-root");
    const recipient = path.join(root, "recipient.txt");
    writeFileSync(recipient, "age1clitest\n", { mode: 0o600 });
    const run = (args: readonly string[]) => spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath },
      encoding: "utf8",
    });
    // strict + 缺失引用：dry-run 与非 dry-run 都非零退出、零发布、无机器成功行。
    for (const extra of ["--dry-run", "--dry-run --require-complete-session-references", "--require-complete-session-references"]) {
      const result = run(extra.split(" "));
      if (extra.includes("--require-complete-session-references")) {
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toMatch(/strict completeness: 1 session reference\(s\) are missing/);
        expect(`${result.stdout}${result.stderr}`).not.toContain("backup-json-report:");
      } else {
        expect(result.status).toBe(0); // 默认兼容行为：dry-run 仍成功
      }
      expect(existsSync(backupRoot)).toBe(false);
    }
  });

  it("strict dry-run with complete references exits 0 but never emits the machine success contract", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-strict-ok-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, '{"ok":true}\n', { mode: 0o600 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, pi_session_file TEXT)");
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("s1", sessionFile);
    db.close();
    const backupRoot = path.join(root, "backup-root");
    const recipient = path.join(root, "recipient.txt");
    writeFileSync(recipient, "age1clitest\n", { mode: 0o600 });
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient, "--dry-run", "--require-complete-session-references"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run: no writes");
    // dry-run 永远不是成功：不得输出机器成功行。
    expect(result.stdout).not.toContain("backup-json-report:");
    expect(existsSync(backupRoot)).toBe(false);
  });
});
