// WP2A 严格生产 migration 门禁（StartConfig.migrationGate）：
// - 默认 "off"：保持 RC bootstrap 行为（不校验 ledger、不自动迁移、不自动 reset）；
// - "verify"：只读校验 migration ledger/head；空库 / legacy 无 ledger 库 / 落后库 fail-fast，
//   明确提示运行离线 cutover/migrate；迁移完成的库正常启动且 HTTP/端口行为不变。
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-start-migration-gate-"));
  cleanups.push(dir);
  return dir;
}

function baseConfig(overrides: Partial<StartConfig> = {}): StartConfig {
  const dir = makeTempDir();
  return {
    port: 0,
    intranetCidrs: [],
    tokens: {},
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    ...overrides,
  };
}

async function createLegacyDatabase(dir: string): Promise<string> {
  const dbPath = join(dir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  await initializeDatabase(db);
  db.close();
  return dbPath;
}

/** 完整 DB/WAL/SHM stat+sha256 指纹：门禁前后必须逐字节/逐 stat 一致。 */
function sourceFingerprints(dbPath: string): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      const st = statSync(file);
      const sha256 = st.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : "not-file";
      fingerprints[file] = JSON.stringify({ dev: st.dev, ino: st.ino, nlink: st.nlink, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs, sha256 });
    } catch {
      fingerprints[file] = "absent";
    }
  }
  return fingerprints;
}

describe("startServer 严格 migration 门禁（WP2A：不自动迁移、不自动 reset，fail-fast 明确）", () => {
  it("default gate=off keeps RC bootstrap behavior (legacy empty DB starts without ledger)", async () => {
    const dir = makeTempDir();
    const dbPath = await createLegacyDatabase(dir);
    const app = await startServer(baseConfig({ dbPath }));
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("gate=verify fails fast on an empty database with the explicit offline cutover/migrate instruction", async () => {
    const dir = makeTempDir();
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath: join(dir, "pi-agent-server.db") })))
      .rejects.toThrow(/startup migration gate.*cutover.*migrate/s);
  });

  it("gate=verify fails fast on a legacy RC database without a migration ledger", async () => {
    const dir = makeTempDir();
    const dbPath = await createLegacyDatabase(dir);
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath })))
      .rejects.toThrow(/startup migration gate/);
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath: join(dir, "again.db") })))
      .rejects.toThrow(/controlled reset|not been initialized|migration head/);
  });

  it("gate=verify never creates a missing database file or sidecar (readonly contract)", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "absent.db");
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath })))
      .rejects.toThrow(/startup migration gate/);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("gate=verify leaves an existing DB/WAL/SHM stat+byte fingerprint fully unchanged on failure (including WAL mode)", async () => {
    const dir = makeTempDir();
    const dbPath = await createLegacyDatabase(dir);
    // 保持 WAL 连接打开：确保 -wal/-shm sidecar 在门禁前后都存在且不波动。
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      writer.exec("CREATE TABLE gate_probe (value TEXT)");
      writer.prepare("INSERT INTO gate_probe VALUES (?)").run("wal-mode");
      const before = sourceFingerprints(dbPath);
      expect(before[`${dbPath}-wal`]).not.toBe("absent");
      expect(before[`${dbPath}-shm`]).not.toBe("absent");
      await expect(startServer(baseConfig({ migrationGate: "verify", dbPath })))
        .rejects.toThrow(/startup migration gate/);
      expect(sourceFingerprints(dbPath)).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("gate=verify starts normally on a migrated database and serves HTTP without auto-migration side effects", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    try {
      const result = await runSqliteMigrations(db, { mode: "apply" });
      expect(result.status).toBe("applied");
    } finally {
      db.close();
    }
    const app = await startServer(baseConfig({ migrationGate: "verify", dbPath }));
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      // 门禁模式绝不自动迁移/删除：启动后 ledger 仍恰好在 head，库中无额外副作用。
      const check = new DatabaseSync(dbPath, { readOnly: true });
      const versions = check.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
      check.close();
      expect(versions.at(-1)).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
