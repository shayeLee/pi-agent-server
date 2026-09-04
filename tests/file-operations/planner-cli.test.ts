// WP4B（方案 A）planner CLI 集成测试（进程内）：
// - SQLite 只读打开：缺失 DB 零创建（无 DB/WAL/SHM）；已有 DB 字节指纹不变；
// - --apply 立即 fail-closed（退出码 2），零 claim/写入/文件操作，确认词不可绕过；
// - PG 无显式 URL 时 fail-closed；真实 PG 只读行为见 tests/postgres/file-operation-planner.test.ts；
// - stdout JSON 与 stderr 均不泄露路径。

import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFileOpsCli, type FileOpsCliIo } from "../../scripts/file-ops.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import type { StorageEnvironment } from "../../src/storage/storage-config.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { dir: string; dataDir: string; dbPath: string; sessionFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-planner-cli-"));
  cleanups.push(dir);
  const dataDir = path.join(dir, "data");
  const dbPath = path.join(dataDir, "pi-agent-server.db");
  const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
  return { dir, dataDir, dbPath, sessionFile };
}

async function createOutboxDb(dbPath: string, sessionFile: string, operationKey = "planner-smoke"): Promise<void> {
  mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/smoke"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"smoke","timestamp":1}}\n', { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  try {
    await runSqliteMigrations(db, { mode: "apply" });
    const createdAt = Date.now();
    db.prepare(
      "INSERT INTO file_operations (id, operation_key, kind, relative_path, session_id, project_id, state, attempt_count, available_at, lease_until, lease_token, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", operationKey, "delete", "sessions/s1/history.jsonl", null, null, "pending", 0, createdAt, null, null, null, createdAt, createdAt);
  } finally {
    db.close();
  }
}

function capture(): { io: FileOpsCliIo; logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  return { logs, errs, io: { log: (line) => logs.push(line), error: (line) => errs.push(line) } };
}

function rowState(dbPath: string): { state: string; attemptCount: number } | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT state, attempt_count FROM file_operations WHERE operation_key = 'planner-smoke'").get() as { state: string; attempt_count: number } | undefined;
    return row ? { state: row.state, attemptCount: Number(row.attempt_count) } : undefined;
  } finally {
    db.close();
  }
}

describe("WP4B planner CLI：dry-run 只读（SQLite）", () => {
  it("默认 run：零写入、零状态变更、DB 字节指纹不变、无 WAL/SHM 伴生文件", async () => {
    const { dir, dataDir, dbPath, sessionFile } = fixture();
    await createOutboxDb(dbPath, sessionFile);
    const before = readFileSync(dbPath);
    const sidecars = () => readdirSync(dataDir).filter((name) => name.startsWith("pi-agent-server.db")).sort();

    const { io, logs, errs } = capture();
    const exit = await runFileOpsCli(["run"], { DB_PATH: dbPath }, io);
    expect(exit).toBe(0);
    const report = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(report.status).toBe("planned");
    expect(report.dialect).toBe("SQLite");
    expect(report.executable).toBe(false);
    expect(report.mode).toBe("dry-run");
    expect(report.planned).toBe(1);
    expect(report.pending).toBe(1);
    expect((report.stateCounts as Record<string, number>).pending).toBe(1);
    expect(errs.join("\n")).toContain("只读 planner");

    // 字节指纹一致 + 无 -wal/-shm 伴生。
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(sidecars()).toEqual(["pi-agent-server.db"]);
    // 行未动、文件未动。
    expect(rowState(dbPath)).toEqual({ state: "pending", attemptCount: 0 });
    expect(existsSync(sessionFile)).toBe(true);
    // 报告不泄露路径与相对路径。
    const stdout = logs.join("\n") + errs.join("\n");
    expect(stdout).not.toContain(dir);
    expect(stdout).not.toContain(dataDir);
    expect(stdout).not.toContain(dbPath);
    expect(stdout).not.toContain("history.jsonl");
    expect(stdout).not.toContain("sessions");
  });

  it("显式 --dry-run 与默认一致；重复 --dry-run 拒绝（退出码 2）", async () => {
    const { dbPath, sessionFile } = fixture();
    await createOutboxDb(dbPath, sessionFile);
    const { io: ioA, logs: logsA } = capture();
    expect(await runFileOpsCli(["run", "--dry-run"], { DB_PATH: dbPath }, ioA)).toBe(0);
    expect((JSON.parse(logsA.join("\n")) as { planned: number }).planned).toBe(1);
    const { io: ioB, logs: logsB, errs: errsB } = capture();
    expect(await runFileOpsCli(["run", "--dry-run", "--dry-run"], { DB_PATH: dbPath }, ioB)).toBe(2);
    expect(logsB).toEqual([]);
    expect(errsB.join("\n")).toContain("只能出现一次");
    expect(existsSync(sessionFile)).toBe(true);
  });
});

describe("WP4B planner CLI：缺失 DB 零创建", () => {
  it("DB_PATH 指向不存在的文件：退出非零且绝不创建 DB/WAL/SHM", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-planner-missing-"));
    cleanups.push(dir);
    const missingDir = path.join(dir, "nowhere");
    mkdirSync(missingDir);
    const dbPath = path.join(missingDir, "pi-agent-server.db");
    const { io, logs, errs } = capture();
    const exit = await runFileOpsCli(["run"], { DB_PATH: dbPath }, io);
    expect(exit).toBe(1);
    expect(logs).toEqual([]);
    // 错误脱敏：不含绝对路径。
    expect(errs.join("\n")).not.toContain(missingDir);
    expect(errs.join("\n")).not.toContain(dir);
    expect(readdirSync(missingDir)).toEqual([]); // 无 DB、无 -wal、无 -shm
  });

  it("无 DB_PATH 或相对 DB_PATH：fail-closed", async () => {
    const { io: ioA, errs: errsA } = capture();
    expect(await runFileOpsCli(["run"], {}, ioA)).toBe(1);
    expect(errsA.join("\n")).toContain("FILE_OPS_FAILED");
    const dir = mkdtempSync(path.join(tmpdir(), "pi-planner-rel-"));
    cleanups.push(dir);
    const { io: ioB, errs: errsB } = capture();
    expect(await runFileOpsCli(["run"], { DB_PATH: "relative.db" }, ioB)).toBe(1);
    expect(errsB.join("\n")).not.toContain("relative.db");
  });
});

describe("WP4B planner CLI：--apply fail-closed", () => {
  it("--apply：退出码 2、零输出 JSON、零状态变更、零文件操作；确认词不可绕过", async () => {
    const { dbPath, sessionFile } = fixture();
    await createOutboxDb(dbPath, sessionFile);
    const before = readFileSync(dbPath);
    const { io, logs, errs } = capture();
    const exit = await runFileOpsCli(["run", "--apply"], { DB_PATH: dbPath }, io);
    expect(exit).toBe(2);
    expect(logs).toEqual([]);
    expect(errs.join("\n")).toContain("--apply 未实现");
    expect(errs.join("\n")).toContain("native helper");
    expect(existsSync(sessionFile)).toBe(true);
    expect(rowState(dbPath)).toEqual({ state: "pending", attemptCount: 0 });
    expect(readFileSync(dbPath).equals(before)).toBe(true);

    // 旧确认词/维护窗口词无法绕过 fail-closed。
    const { io: ioB, logs: logsB, errs: errsB } = capture();
    const exitB = await runFileOpsCli(
      ["run", "--apply", "--confirm-maintenance", "EXECUTE_FILE_OPERATIONS", "--maintenance-window", "CONFIRMED"],
      { DB_PATH: dbPath },
      ioB,
    );
    expect(exitB).toBe(2);
    expect(logsB).toEqual([]);
    expect(errsB.join("\n")).toContain("--apply 未实现");
    expect(rowState(dbPath)).toEqual({ state: "pending", attemptCount: 0 });
    expect(existsSync(sessionFile)).toBe(true);
  });

  it("未知参数：退出码 2", async () => {
    const { dbPath, sessionFile } = fixture();
    await createOutboxDb(dbPath, sessionFile);
    const { io, logs, errs } = capture();
    expect(await runFileOpsCli(["run", "--frobnicate"], { DB_PATH: dbPath }, io)).toBe(2);
    expect(logs).toEqual([]);
    expect(errs.join("\n")).toContain("未知参数");
    expect(existsSync(sessionFile)).toBe(true);
  });
});

describe("WP4B planner CLI：PostgreSQL 门禁", () => {
  it("无显式 PI_STORAGE_DIALECT=postgres + URL：fail-closed，不尝试连接", async () => {
    const { io: ioA, logs: logsA } = capture();
    // 只有方言没有 URL → 拒绝。
    const env: StorageEnvironment = { PI_STORAGE_DIALECT: "postgres" };
    expect(await runFileOpsCli(["run"], env, ioA)).toBe(1);
    expect(logsA).toEqual([]);
    // 未显式方言 + URL 也被拒绝（planner 不隐式使用 PG）。
    const { io: ioB, logs: logsB } = capture();
    expect(await runFileOpsCli(["run"], { PI_DATABASE_URL: "postgresql://user:pass@host:1/db" }, ioB)).toBe(1);
    expect(logsB).toEqual([]);
  });
});