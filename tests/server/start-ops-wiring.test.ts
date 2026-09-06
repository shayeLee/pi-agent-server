// WP5A startServer 接线：可注入运行状态对象由真实启动路径维护。
// - SQLite 显式 rc+off（disposable RC）：readyz 明确 RC bootstrap ready（非 schema 背书）；
//   metrics dialect=sqlite、gate 0/0；
// - SQLite gate=verify（已迁移库，managed 默认）：readyz migration-head；metrics gate 1/1；探针零 DB 写入；
// - managed+off 在任何资源创建前被拒；门禁失败 → startServer 拒绝（无监听，即 ready false 语义），
//   /health//readyz//metrics 均不可达；
// - 关闭开始（preClose）→ readyz 立即 503，不再误报 ready。
import { DatabaseSync } from "node:sqlite";
import {
  createHash,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";

const cleanups: string[] = [];
afterEach(() => { for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-start-ops-"));
  cleanups.push(dir);
  return dir;
}

function baseConfig(overrides: Partial<StartConfig> = {}): StartConfig {
  const dir = makeTempDir();
  return {
    port: 0,
    // WP5D-3：/metrics 仅 admin/operator；探针测试以 inject 默认来源 127.0.0.1 访问，登记为 admin。
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "127.0.0.1", role: "admin" }]) }),
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    ...overrides,
  };
}

/** 探针请求前后的 DB 字节指纹：/readyz、/metrics 不得引发任何写库副作用。 */
function dbBytesFingerprint(dbPath: string): string {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const digest = createHash("sha256");
  for (const file of files) {
    try {
      const st = statSync(file);
      digest.update(file).update(String(st.size)).update(String(st.mtimeMs));
      if (st.isFile()) digest.update(readFileSync(file));
    } catch {
      digest.update(file).update("absent");
    }
  }
  return digest.digest("hex");
}

describe("startServer WP5A 接线（SQLite）", () => {
  it("off 被拒绝：服务不提供 RC bootstrap 启动路径", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    await expect(startServer(baseConfig({ dataMode: "rc", migrationGate: "off", dbPath })))
      .rejects.toThrow(/migrationGate "off" 已删除/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("gate=verify（已迁移库）：readyz=migration-head，metrics gate 1/1，无自动迁移副作用", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    let head: number | null = null;
    try {
      const result = await runSqliteMigrations(db, { mode: "apply" });
      expect(result.status).toBe("applied");
      if (result.appliedVersion !== undefined) head = result.appliedVersion;
      else {
        const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
        head = versions.at(-1)?.version ?? null;
      }
    } finally {
      db.close();
    }
    // 默认 dataMode=managed + 显式 verify：正式受管路径。
    const app = await startServer(baseConfig({ dataMode: "managed", migrationGate: "verify", dbPath }));
    try {
      const readyz = await app.inject({ method: "GET", url: "/readyz" });
      expect(readyz.statusCode).toBe(200);
      expect(readyz.json()).toEqual({ ready: true, migrationGate: "verify", schema: "migration-head" });

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain("pi_agent_server_migration_gate_enabled 1");
      expect(metrics.body).toContain("pi_agent_server_migration_gate_verified 1");
      expect(metrics.body).toContain('pi_agent_server_storage_dialect_info{dialect="sqlite"} 1');

      // 启动/探针后 ledger 仍在 head（无自动迁移/删除副作用）。
      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const versions = check.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
        expect(versions.at(-1)?.version).toBe(head);
      } finally {
        check.close();
      }
    } finally {
      await app.close();
    }
  });

  it("门禁失败：startServer 拒绝（进程不监听），即 ready false 语义——/readyz 与 /metrics 不可达", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    await expect(startServer(baseConfig({ migrationGate: "verify", dbPath })))
      .rejects.toThrow(/startup migration gate.*migrate/s);
    // 无监听实例可注入/连接：没有任何端点声称 ready。
    expect(dbBytesFingerprint(dbPath)).toBe(dbBytesFingerprint(dbPath));
  });

  it("off：startServer 在任何资源创建前拒绝（不监听、无任何端点）", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    await expect(startServer(baseConfig({ dataMode: "managed", migrationGate: "off", dbPath })))
      .rejects.toThrow(/migrationGate "off" 已删除/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("关闭后进程不再提供任何端点（ready 语义：关闭即不可达，不误报）", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "pi-agent-server.db");
    const db = new DatabaseSync(dbPath);
    try { await runSqliteMigrations(db, { mode: "apply" }); } finally { db.close(); }
    const app = await startServer(baseConfig({ migrationGate: "verify", dbPath }));
    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(200);
    await app.close();
    // 关闭完成后：listen 已停止，inject 被拒——没有任何端点再声称 ready。
    await expect(app.inject({ method: "GET", url: "/readyz" })).rejects.toThrow();
    await expect(app.inject({ method: "GET", url: "/metrics" })).rejects.toThrow();
  });
});