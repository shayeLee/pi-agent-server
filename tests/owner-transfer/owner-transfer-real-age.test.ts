// WP5D-4 真实 age 门禁（SQLite 全链路 owner transfer 演练）：
// 仅在 PI_RUN_REAL_AGE_OWNER_TRANSFER=1 且 age/age-keygen 可用时运行（由
// `pnpm test:owner-transfer` 接线，该脚本先运行 `pnpm test:age`；普通 `pnpm test` 中
// 安全 skip，发布门禁由 verify:release 强制）。全部操作只发生在临时目录，绝不触碰真实
// 用户 SQLite/PG/JSONL。断言：真实 age 加密 pre-owner-transfer 备份可解密、kind 正确、
// 转移只改 owner_key、default 项目 owner='' 保留、报告仅含 subject hash/counts。
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup, verifyPublishedBackup } from "../../src/backup/backup-core.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import {
  authorizeOwnerTransfer,
  ownerKeyForIp,
  parseOwnerTransferArgs,
  resolveSqliteOwnerTransferTarget,
  revalidateSqliteOwnerTransferTarget,
  runOwnerTransfer,
  runSqliteOwnerTransfer,
  subjectHashForIp,
} from "../../src/owner-transfer/owner-transfer-core.js";
import { resolveBackupCliPaths, type StorageEnvironment } from "../../src/storage/storage-config.js";

const REQUIRED = process.env.PI_RUN_REAL_AGE_OWNER_TRANSFER === "1";
const ageAvailable = REQUIRED && spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("age-keygen", ["-h"], { stdio: "ignore" }).status === 0
  ? true : false;
const describeGate = ageAvailable ? describe : describe.skip;

const SOURCE = "10.1.2.3";
const TARGET = "10.1.2.4";
const SOURCE_OWNER = ownerKeyForIp(SOURCE);
const TARGET_OWNER = ownerKeyForIp(TARGET);

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describeGate("WP5D-4 real-age SQLite owner-transfer gate", () => {
  it("performs backup→verify→revalidate→transfer with real age encryption end to end", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-real-age-"));
    cleanups.push(root);
    const cwd = path.join(root, "app-cwd");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(dataDir, ".pi-agent");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "projects", "p1", "sessions", "s2"), { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
    const projectSessionFile = path.join(dataDir, "projects", "p1", "sessions", "s2", "history.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/cwd"}\n', { mode: 0o600 });
    writeFileSync(projectSessionFile, '{"type":"session","version":3,"id":"header-p","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/cwd"}\n', { mode: 0o600 });
    writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
    const backupRoot = path.join(root, "backups");
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    await initializeDatabase(db);
    const insertProject = db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)");
    insertProject.run(DEFAULT_PROJECT_ID, "默认项目", cwd, "", 0);
    insertProject.run("p1", "custom", "/cwd", SOURCE_OWNER, 1);
    const insertSession = db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insertSession.run("s1", SOURCE_OWNER, DEFAULT_PROJECT_ID, "default-session", 1, 1, sessionFile, "{}");
    insertSession.run("s2", SOURCE_OWNER, "p1", "project-session", 1, 1, projectSessionFile, "{}");
    // An unrelated owner sitting on the shared default project must be untouched.
    insertSession.run("s3", ownerKeyForIp("10.1.2.9"), DEFAULT_PROJECT_ID, "other", 1, 1, null, "{}");
    db.close();

    const identity = path.join(root, "identity");
    const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
    expect(generated.status).toBe(0);
    const recipient = path.join(root, "recipient.txt");
    const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
    expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
    writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });

    const cli = parseOwnerTransferArgs([
      "--apply", "--source-ip", SOURCE, "--target-ip", TARGET,
      "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
      "--backup-root", backupRoot, "--age-recipient-file", recipient,
    ]);
    const environment: StorageEnvironment = { AGENT_CWD: cwd, DATA_DIR: dataDir, DB_PATH: dbPath, PI_AGENT_DIR: agentDir };
    const target = resolveSqliteOwnerTransferTarget(environment, cli);
    const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
    const previousStaging = process.env.PI_BACKUP_STAGING_ROOT;
    try {
      const report = await runOwnerTransfer(authorizeOwnerTransfer(cli), {
        createBackup: () => createSqliteBackup({ paths: { ...paths, authPath: target.authPath }, backupKind: "pre-owner-transfer" }),
        verifyBackup: verifyPublishedBackup,
        revalidateBeforeTransfer: (verification) => revalidateSqliteOwnerTransferTarget(environment, cli, target, verification),
        transfer: () => {
          const tx = new DatabaseSync(target.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
          try { return runSqliteOwnerTransfer(tx, SOURCE_OWNER, TARGET_OWNER); }
          finally { try { tx.close(); } catch { /* preserve result */ } }
        },
      }, { dialect: "SQLite", sourceSubjectHash: subjectHashForIp(SOURCE), targetSubjectHash: subjectHashForIp(TARGET) });

      expect(report.status).toBe("success");
      expect(report.mode).toBe("apply");
      expect(report.dialect).toBe("SQLite");
      expect(report.sourceSubjectHash).toBe(subjectHashForIp(SOURCE));
      expect(report.targetSubjectHash).toBe(subjectHashForIp(TARGET));
      expect(report.transfer.projectsTransferred).toBe(1);
      expect(report.transfer.sessionsTransferred).toBe(2);
      expect(report.transfer.defaultProjectOwnerPreserved).toBe(true);
      expect(report.backup.kind).toBe("pre-owner-transfer");
      expect(report.backup.checksum).toMatch(/^[0-9a-f]{64}$/);
      // Desensitization: the report contains no raw IP / owner / path / url.
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(SOURCE);
      expect(serialized).not.toContain(TARGET);
      expect(serialized).not.toContain(dbPath);
      expect(serialized).not.toContain(dataDir);

      // Encrypted package can be decrypted with real age: kind=pre-owner-transfer.
      const packages = readdirSync(backupRoot);
      expect(packages).toHaveLength(1);
      const packagePath = path.join(backupRoot, packages[0]!);
      const manifest = spawnSync("age", ["--decrypt", "--identity", identity, path.join(packagePath, "manifest.json.age")], { encoding: "utf8" });
      expect(manifest.status).toBe(0);
      const metadata = JSON.parse(manifest.stdout) as { kind: string; dialect: string };
      expect(metadata.kind).toBe("pre-owner-transfer");
      expect(metadata.dialect).toBe("SQLite");

      // DB state: only owner_key changed; default project owner stays ''.
      const check = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
      const projectOwners = Object.fromEntries(
        (check.prepare("SELECT id, owner_key FROM projects").all() as Array<{ id: string; owner_key: string }>).map((row) => [row.id, row.owner_key]),
      );
      const sessionOwners = Object.fromEntries(
        (check.prepare("SELECT id, owner_key FROM sessions").all() as Array<{ id: string; owner_key: string }>).map((row) => [row.id, row.owner_key]),
      );
      check.close();
      expect(projectOwners[DEFAULT_PROJECT_ID]).toBe("");
      expect(projectOwners.p1).toBe(TARGET_OWNER);
      expect(sessionOwners.s1).toBe(TARGET_OWNER);
      expect(sessionOwners.s2).toBe(TARGET_OWNER);
      expect(sessionOwners.s3).toBe(ownerKeyForIp("10.1.2.9"));

      // JSONL files and models.json are untouched.
      expect(readFileSync(sessionFile, "utf8")).toContain("header");
      expect(readFileSync(projectSessionFile, "utf8")).toContain("header-p");
      expect(readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe('{"models":[]}\n');
      expect(readFileSync(path.join(packagePath, "COMPLETE"), "utf8").trim()).not.toBe("");
    } finally {
      if (previousStaging === undefined) delete process.env.PI_BACKUP_STAGING_ROOT;
      else process.env.PI_BACKUP_STAGING_ROOT = previousStaging;
    }
  }, 120_000);

  it("publishes the pre-owner-transfer backup and transfers owners despite a missing referenced JSONL (missing-as-empty)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-real-age-missing-"));
    cleanups.push(root);
    const cwd = path.join(root, "app-cwd");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(dataDir, ".pi-agent");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/cwd"}\n', { mode: 0o600 });
    writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
    const backupRoot = path.join(root, "backups");
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    await initializeDatabase(db);
    const insertProject = db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)");
    insertProject.run(DEFAULT_PROJECT_ID, "默认项目", cwd, "", 0);
    insertProject.run("p1", "custom", "/cwd", SOURCE_OWNER, 1);
    const insertSession = db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref, capability_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insertSession.run("s1", SOURCE_OWNER, DEFAULT_PROJECT_ID, "default-session", 1, 1, sessionFile, "{}");
    // s2 引用一个不存在的 JSONL：missing-as-empty 下备份照常发布、转移照常执行。
    const ghostFile = path.join(dataDir, "sessions", "s2", "ghost.jsonl");
    insertSession.run("s2", SOURCE_OWNER, DEFAULT_PROJECT_ID, "ghost-session", 1, 1, ghostFile, "{}");
    db.close();

    const identity = path.join(root, "identity");
    const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
    expect(generated.status).toBe(0);
    const recipient = path.join(root, "recipient.txt");
    const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
    writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });

    const cli = parseOwnerTransferArgs([
      "--apply", "--source-ip", SOURCE, "--target-ip", TARGET,
      "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
      "--backup-root", backupRoot, "--age-recipient-file", recipient,
    ]);
    const environment: StorageEnvironment = { AGENT_CWD: cwd, DATA_DIR: dataDir, DB_PATH: dbPath, PI_AGENT_DIR: agentDir };
    const target = resolveSqliteOwnerTransferTarget(environment, cli);
    const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
    const previousStaging = process.env.PI_BACKUP_STAGING_ROOT;
    try {
      const report = await runOwnerTransfer(authorizeOwnerTransfer(cli), {
        createBackup: () => createSqliteBackup({ paths: { ...paths, authPath: target.authPath }, backupKind: "pre-owner-transfer" }),
        verifyBackup: verifyPublishedBackup,
        revalidateBeforeTransfer: (verification) => revalidateSqliteOwnerTransferTarget(environment, cli, target, verification),
        transfer: () => {
          const tx = new DatabaseSync(target.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
          try { return runSqliteOwnerTransfer(tx, SOURCE_OWNER, TARGET_OWNER); }
          finally { try { tx.close(); } catch { /* preserve result */ } }
        },
      }, { dialect: "SQLite", sourceSubjectHash: subjectHashForIp(SOURCE), targetSubjectHash: subjectHashForIp(TARGET) });
      expect(report.status).toBe("success");
      expect(report.backup.kind).toBe("pre-owner-transfer");

      // 缺失引用不阻止转移：owner 行照常转移（含 ghost session s2）。
      const check = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
      const projectOwners = Object.fromEntries(
        (check.prepare("SELECT id, owner_key FROM projects").all() as Array<{ id: string; owner_key: string }>).map((row) => [row.id, row.owner_key]),
      );
      const sessionOwners = Object.fromEntries(
        (check.prepare("SELECT id, owner_key FROM sessions").all() as Array<{ id: string; owner_key: string }>).map((row) => [row.id, row.owner_key]),
      );
      check.close();
      expect(projectOwners[DEFAULT_PROJECT_ID]).toBe("");
      expect(projectOwners.p1).toBe(TARGET_OWNER);
      expect(sessionOwners.s1).toBe(TARGET_OWNER);
      expect(sessionOwners.s2).toBe(TARGET_OWNER);

      // 已发布带 COMPLETE 的 pre-owner-transfer 包，且 manifest 记录了缺失引用。
      const packages = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
      expect(packages).toHaveLength(1);
      const packagePath = path.join(backupRoot, packages[0]!);
      expect(existsSync(path.join(packagePath, "COMPLETE"))).toBe(true);
      const decrypted = spawnSync("age", ["--decrypt", "--identity", identity, path.join(packagePath, "manifest.json.age")], { encoding: "utf8" });
      expect(decrypted.status).toBe(0);
      const manifest = JSON.parse(decrypted.stdout);
      expect(manifest.missingSessionReferences).toEqual([{ sessionId: "s2", path: "sessions/s2/ghost.jsonl", status: "missing" }]);
    } finally {
      if (previousStaging === undefined) delete process.env.PI_BACKUP_STAGING_ROOT;
      else process.env.PI_BACKUP_STAGING_ROOT = previousStaging;
    }
  }, 120_000);
});