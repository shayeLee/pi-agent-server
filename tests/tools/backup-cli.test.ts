import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBackupArgs, redactMessage, backupMachineReportLine, BACKUP_MACHINE_REPORT_PREFIX } from "../../scripts/backup.js";
import { resolveBackupCliPaths } from "../../src/storage/storage-config.js";
import { createCanonicalSqliteBaseline, insertCanonicalSession } from "../backup/sqlite-fixture.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function createCanonicalLedger(db: DatabaseSync): void {
  createCanonicalSqliteBaseline(db);
}

describe("offline backup CLI", () => {
  it("requires create, absolute AGENT_CWD, backup root and recipient file", () => {
    expect(() => parseBackupArgs([])).toThrow(/用法/);
    expect(() => parseBackupArgs(["create", "--backup-root", "/tmp/x"])).toThrow(/recipient/);
    expect(() => resolveBackupCliPaths({ AGENT_CWD: "relative" }, "/tmp/backup", "/tmp/recipient")).toThrow(/absolute AGENT_CWD/);
    expect(() => resolveBackupCliPaths({ AGENT_CWD: "/workspace" }, "relative", "/tmp/recipient")).toThrow(/absolute --backup-root/);
    expect(() => resolveBackupCliPaths({ AGENT_CWD: "/workspace" }, "/tmp/backup", "relative")).toThrow(/absolute --age-recipient-file/);
  });

  it("rejects the retired strict completeness flag as unknown and parses the standard flags", () => {
    const parsed = parseBackupArgs(["create", "--backup-root", "/tmp/x", "--age-recipient-file", "/tmp/r"]);
    expect(parsed.dryRun).toBe(false);
    // 退役：--require-complete-session-references 不再被接受，与任何未知参数一样 fail-closed。
    expect(() => parseBackupArgs(["create", "--backup-root", "/tmp/x", "--age-recipient-file", "/tmp/r", "--require-complete-session-references"])).toThrow(/未知参数/);
    const withDryRun = parseBackupArgs(["create", "--backup-root", "/tmp/x", "--age-recipient-file", "/tmp/r", "--dry-run"]);
    expect(withDryRun.dryRun).toBe(true);
  });

  it("emits the machine success line on every published backup, counting missing references as missing-as-empty; never on dry-run", () => {
    const line = backupMachineReportLine("sqlite", { finalPath: "/abs/backup-root/backup-1", files: [{ path: "a" }], missingSessionReferences: [] });
    expect(line).toBe(`${BACKUP_MACHINE_REPORT_PREFIX}: {"dialect":"sqlite","status":"published","dryRun":false,"finalPath":"/abs/backup-root/backup-1","payloadCount":1,"missingSessionReferences":0}`);
    expect(backupMachineReportLine("postgres", { finalPath: "/abs/backup-root/backup-1", files: [], missingSessionReferences: [] })).toMatch(/"dialect":"postgres"/);
    // dry-run（finalPath 为 null）不产生成功行；缺失引用可以大于零且不阻止发布。
    expect(backupMachineReportLine("sqlite", { finalPath: null, files: [], missingSessionReferences: [] })).toBeNull();
    const withMissing = backupMachineReportLine("sqlite", { finalPath: "/abs/backup-root/backup-1", files: [], missingSessionReferences: [{ sessionId: "x", path: "y", status: "missing" }] });
    expect(withMissing).toBe(`${BACKUP_MACHINE_REPORT_PREFIX}: {"dialect":"sqlite","status":"published","dryRun":false,"finalPath":"/abs/backup-root/backup-1","payloadCount":0,"missingSessionReferences":1}`);
  });

  it("dry-run does not create backup root and does not require a system age binary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-test-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    createCanonicalLedger(db);
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
    createCanonicalLedger(db);
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

  it("missing session references publish as missing-as-empty through the real CLI (source), with the machine report counting them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-missing-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "sessions", "ok"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, "sessions", "ok", "history.jsonl"), '{"ok":true}\n', { mode: 0o600 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    createCanonicalLedger(db);
    insertCanonicalSession(db, "ok", path.join(dataDir, "sessions", "ok", "history.jsonl"));
    insertCanonicalSession(db, "missing-cli-session", path.join(dataDir, "sessions", "missing-cli-session", "history.jsonl"));
    db.close();
    const backupRoot = path.join(root, "backup-root");
    const stagingRoot = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-missing-staging-"));
    cleanups.push(stagingRoot);
    const recipientFile = path.join(root, "recipient.txt");
    const identity = path.join(root, "identity");
    expect(spawnSync("age-keygen", ["--output", identity], { stdio: "ignore" }).status).toBe(0);
    const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    expect(publicKey.status).toBe(0);
    writeFileSync(recipientFile, `${publicKey.stdout.trim()}\n`, { mode: 0o600 });
    const spawnCli = (args: readonly string[]) => spawnSync("pnpm", ["exec", "tsx", "scripts/backup.ts", "--", "create", "--backup-root", backupRoot, "--age-recipient-file", recipientFile, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_BACKUP_STAGING_ROOT: stagingRoot },
      encoding: "utf8",
    });
    // 缺失引用仍发布：dry-run 与真实发布都成功，发布路径输出机器报告且计数为 1。
    const dry = spawnCli(["--dry-run"]);
    expect(dry.status, `dry-run exited ${dry.status}; output:\n${dry.stdout}${dry.stderr}`).toBe(0);
    expect(dry.stdout).toContain("dry-run: no writes");
    expect(dry.stdout).not.toContain("backup-json-report:");
    expect(existsSync(backupRoot)).toBe(false);
    const published = spawnCli([]);
    expect(published.status, `CLI exited ${published.status}; output:\n${published.stdout}${published.stderr}`).toBe(0);
    expect(published.stdout).toMatch(/missing session reference\(s\)/);
    const line = published.stdout.split(/\r?\n/).find((entry) => entry.startsWith("backup-json-report: "));
    expect(line).toBeTruthy();
    const report = JSON.parse(line!.slice("backup-json-report: ".length));
    expect(report).toMatchObject({ dialect: "sqlite", status: "published", dryRun: false, missingSessionReferences: 1 });
    expect(typeof report.payloadCount).toBe("number");
    expect(report.finalPath.startsWith(backupRoot)).toBe(true);
    expect(existsSync(path.join(report.finalPath, "COMPLETE"))).toBe(true);
  });

  it("a published backup never emits the machine success line when dry-run (complete references, no flag)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-backup-cli-dry-"));
    cleanups.push(root);
    const dataDir = path.join(root, "data");
    const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, '{"ok":true}\n', { mode: 0o600 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    createCanonicalLedger(db);
    insertCanonicalSession(db, "s1", sessionFile);
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
    // dry-run 永远不是成功：不得输出机器成功行。
    expect(result.stdout).not.toContain("backup-json-report:");
    expect(existsSync(backupRoot)).toBe(false);
  });
});
