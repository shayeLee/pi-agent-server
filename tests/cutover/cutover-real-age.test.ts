// WP2A 真实 age 门禁（SQLite 全链路 cutover 演练）：
// 仅在 PI_RUN_REAL_AGE_CUTOVER=1 且 age/age-keygen 可用时运行（由 `pnpm test:cutover` 接线，
// 该脚本先运行 `pnpm test:age`；普通 `pnpm test` 中安全 skip，发布门禁由 verify:release 强制）。
// 全部操作只发生在临时目录，绝不触碰真实用户 SQLite/PG/JSONL。
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup, verifyPublishedBackup } from "../../src/backup/backup-core.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import {
  applySqliteMigrationsAfterReset,
  authorizeCutover,
  parseCutoverArgs,
  resetSqliteForCutover,
  resolveSqliteCutoverTarget,
  runControlledCutover,
} from "../../src/cutover/cutover-core.js";
import { resolveBackupCliPaths, type StorageEnvironment } from "../../src/storage/storage-config.js";

const REQUIRED = process.env.PI_RUN_REAL_AGE_CUTOVER === "1";
const ageAvailable = REQUIRED && spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("age-keygen", ["-h"], { stdio: "ignore" }).status === 0
  ? true : false;
const describeGate = ageAvailable ? describe : describe.skip;

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describeGate("WP2A real-age SQLite cutover gate", () => {
  it("performs backup→verify→reset→migrate→verify with real age encryption end to end", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-cutover-real-age-"));
    cleanups.push(root);
    const cwd = path.join(root, "app-cwd");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(dataDir, ".pi-agent");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/legacy"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"legacy","timestamp":1}}\n', { mode: 0o600 });
    writeFileSync(path.join(agentDir, "models.json"), '{"models":[]}\n', { mode: 0o600 });
    const dbPath = path.join(dataDir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    await initializeDatabase(db);
    db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)").run("p1", "legacy", "/legacy", "owner", 1);
    db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, capability_versions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("s1", "owner", "p1", "legacy", 1, 1, sessionFile, "{}");
    db.close();

    const identity = path.join(root, "identity");
    const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
    expect(generated.status).toBe(0);
    const recipient = path.join(root, "recipient.txt");
    const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
    expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
    writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });

    const cli = parseCutoverArgs([
      "--apply", "--reset-rc-data", "--confirm-reset", "DELETE_RC_DATA",
      "--maintenance-window", "CONFIRMED",
      "--backup-root", path.join(root, "backups"), "--age-recipient-file", recipient,
    ]);
    const environment: StorageEnvironment = { AGENT_CWD: cwd, DATA_DIR: dataDir, DB_PATH: dbPath, PI_AGENT_DIR: agentDir };
    const target = resolveSqliteCutoverTarget(environment, cli);
    const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
    const report = await runControlledCutover(authorizeCutover(cli), {
      createBackup: () => createSqliteBackup({ paths, backupKind: "pre-reset" }),
      verifyBackup: verifyPublishedBackup,
      reset: () => resetSqliteForCutover(target),
      applyMigration: () => applySqliteMigrationsAfterReset(target.dbPath),
      verifyMigration: async () => {
        const verifyDb = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
        try { return await runSqliteMigrations(verifyDb, { mode: "verify" }); }
        finally { verifyDb.close(); }
      },
    }, { dialect: "SQLite" });

    expect(report.status).toBe("success");
    expect(report.legacy).toBe(true);
    expect(report.backup.kind).toBe("pre-reset");
    expect(report.backup.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(report.migration.appliedVersion).toBe(report.verify.appliedVersion);

    // 加密包可被真实 age 解密：manifest 记录 legacy 无 ledger、kind=pre-reset。
    const packages = readdirSync(path.join(root, "backups"));
    expect(packages).toHaveLength(1);
    const packagePath = path.join(root, "backups", packages[0]!);
    expect(existsSync(path.join(packagePath, "COMPLETE"))).toBe(true);
    const manifest = spawnSync("age", ["--decrypt", "--identity", identity, path.join(packagePath, "manifest.json.age")], { encoding: "utf8" });
    expect(manifest.status).toBe(0);
    const metadata = JSON.parse(manifest.stdout) as { kind: string; migrationLedger: { present: boolean } };
    expect(metadata.kind).toBe("pre-reset");
    expect(metadata.migrationLedger.present).toBe(false);

    // Reset + 迁移基线：JSONL 根清空、models.json 保留、新 DB 带 ledger。
    expect(existsSync(path.join(dataDir, "sessions"))).toBe(false);
    expect(readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe('{"models":[]}\n');
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const ledger = check.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    check.close();
    expect(ledger.length).toBeGreaterThan(0);
    expect(readFileSync(path.join(packagePath, "COMPLETE"), "utf8").trim()).not.toBe("");
  }, 120_000);
});
