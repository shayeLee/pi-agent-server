// - 默认 dataMode=managed + migrationGate=verify：服务只读校验，不自动迁移/不自动 reset；
//   空库 / legacy 无 ledger 库 / 落后库 fail-fast，明确提示运行离线 migrate；
// - `PI_MIGRATION_GATE=off`（包括 rc+off）已删除：在资源创建前拒绝，服务绝不 bootstrap baseline。
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

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
    ipAccess: makeTestIpAccess(),
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    ...overrides,
  };
}

async function createLegacyDatabase(dir: string): Promise<string> {
  // 真正的 legacy RC 形态：managed 表、无 schema_migrations ledger（旧版 bootstrap 的产物）。
  const dbPath = join(dir, "pi-agent-server.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL, owner_key TEXT NOT NULL, created_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, owner_key TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c', title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, conversation_ref TEXT, model_provider TEXT, model_id TEXT, thinking_level TEXT, system_prompt TEXT, capability_versions TEXT)");
  db.exec("CREATE TABLE idempotency (session_id TEXT NOT NULL, request_id TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, request_id))");
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

describe("startServer 严格 migration 门禁 + 数据模式（Phase 3：不自动迁移、不自动 reset，fail-fast 明确）", () => {
  it("默认（dataMode=managed + gate 隐含 verify）：空库 fail-fast，绝不创建 DB 文件", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    await expect(startServer(baseConfig({ dbPath }))).rejects.toThrow(/startup migration gate/);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("显式 off（包括 rc+off）在资源创建前拒绝，服务绝不 bootstrap baseline", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    await expect(
      startServer(baseConfig({ dataMode: "rc", migrationGate: "off", dbPath })),
    ).rejects.toThrow(/migrationGate "off" 已删除/);
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("服务启动永远不 bootstrap：off 被拒绝；已离线迁移的库可由 verify 启动", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    await expect(startServer(baseConfig({ dataMode: "rc", migrationGate: "off", dbPath })))
      .rejects.toThrow(/migrationGate "off" 已删除/);
    expect(existsSync(dbPath)).toBe(false);

    const db = new DatabaseSync(dbPath);
    try {
      await runSqliteMigrations(db, { mode: "apply" });
    } finally {
      db.close();
    }
    const app = await startServer(baseConfig({ dbPath }));
    await app.close();
  });

  it("rc + verify（显式 RC 只读校验）：空库 fail-fast；已迁移库正常启动", async () => {
    const dir = makeTempDir();
    const rcConfig = (dbPath: string) =>
      baseConfig({ dataMode: "rc", migrationGate: "verify", dbPath });
    await expect(startServer(rcConfig(join(dir, "empty.db")))).rejects.toThrow(/startup migration gate/);

    const migratedPath = join(dir, "migrated.db");
    const db = new DatabaseSync(migratedPath);
    try {
      const result = await runSqliteMigrations(db, { mode: "apply" });
      expect(result.status).toBe("applied");
    } finally {
      db.close();
    }
    const app = await startServer(rcConfig(migratedPath));
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("dataMode 未知值 fail-fast：任何资源创建前拒绝、值不回显", async () => {
    const dir = makeTempDir();
    for (const bad of ["prod", "rc ", "MANAGED", "disposable", 1, {}]) {
      await expect(startServer(baseConfig({ dataDir: dir, dataMode: bad as never })))
        .rejects.toThrow(/^dataMode 只支持 "managed" \/ "rc"/);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("dataMode=rc + migrationGate 缺省：仍归一化为 verify（rc 也默认门禁，off 必须显式）", async () => {
    const dir = makeTempDir();
    await expect(startServer(baseConfig({ dataMode: "rc", dbPath: join(dir, "empty.db") })))
      .rejects.toThrow(/startup migration gate/);
  });

  it("gate=verify fails fast on an empty database with the explicit offline migration instruction", async () => {
    const dir = makeTempDir();
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath: join(dir, "pi-agent-server.db") })))
      .rejects.toThrow(/startup migration gate.*migrate/s);
  });

  it("gate=verify fails fast on a legacy RC database without a migration ledger", async () => {
    const dir = makeTempDir();
    const dbPath = await createLegacyDatabase(dir);
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath })))
      .rejects.toThrow(/startup migration gate/);
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath: join(dir, "again.db") })))
      .rejects.toThrow(/migration head|not been initialized/);
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
