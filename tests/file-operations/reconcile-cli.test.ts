// WP4C（方案 A 收敛）reconcile analyzer CLI 集成测试（进程内）：
// - SQLite 只读打开：缺失 DB 零创建（无 DB/WAL/SHM）；已有 DB 字节指纹不变；
// - DATA_DIR 纯字符串契约：显式、绝对、非 root；缺失/相对/root fail-closed；
//   不存在（未创建）的绝对 DATA_DIR 合法——分析绝不触碰文件系统；
// - null 引用 = normal unmaterialized（计数非 issue）；词法非法/重复引用 →
//   固定 issue codes + opaque 引用；
// - --apply 立即 fail-closed（退出码 2），确认词不可绕过；未知/重复参数拒绝；
// - stdout JSON 与 stderr 均不泄露路径/URL/session id/prompt 内容；
// - PG 无显式 URL fail-closed（不发起连接）；URL 严格校验（协议/host/database
//   显式、禁止 fragment）；options 只允许 search_path（严格解析、其余拒绝）；
//   真实 PG 只读行为见 tests/postgres/reconcile-jsonl.test.ts；
// - CLI 主入口识别零 fs：纯 path/fileURL 判断（无 realpath/stat），SQLite 只读
//   打开是本 CLI 唯一必要的文件系统访问（源码级卫生断言）。

import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runReconcileJsonlCli,
  readOnlyReconcilePostgresUrl,
  type ReconcileJsonlCliIo,
} from "../../scripts/reconcile-jsonl.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { StorageEnvironment } from "../../src/storage/storage-config.js";
import type { ReconcileReport } from "../../src/file-operations/reconcile.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const OTHER_PROJECT = "11111111-2222-4333-8444-555555555555";

interface Fixture {
  readonly dir: string;
  readonly dataDir: string;
  readonly dbPath: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-reconcile-cli-"));
  cleanups.push(dir);
  // dataDir 仅作为字符串参与绑定：不创建目录（证明 CLI 不扫描文件系统）。
  const dataDir = path.join(dir, "data");
  return { dir, dataDir, dbPath: path.join(dir, "pi-agent-server.db") };
}

function insertSession(db: DatabaseSync, sessionId: string, projectId: string, piSessionFile: string | null): void {
  db.prepare(
    "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(sessionId, "owner", projectId, "title", 1, 1, piSessionFile, null, null, null, null, null);
}

async function createReconcileDb(f: Fixture): Promise<void> {
  const db = new DatabaseSync(f.dbPath);
  try {
    await runSqliteMigrations(db, { mode: "apply" });
    db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run(
      DEFAULT_PROJECT_ID, "默认项目", "/tmp", "", 0,
    );
    db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run(
      OTHER_PROJECT, "项目B", "/tmp/b", "", 0,
    );
  } finally {
    db.close();
  }
}

/** 标准分析场景：valid(default) + valid(other) + null + invalid(traversal) + duplicate。 */
async function standardFixture(): Promise<Fixture> {
  const f = fixture();
  await createReconcileDb(f);
  const db = new DatabaseSync(f.dbPath);
  try {
    insertSession(db, "s1", DEFAULT_PROJECT_ID, path.join(f.dataDir, "sessions", "s1", "2025-01-01T00-00-00_s1.jsonl")); // valid default
    insertSession(db, "s2", OTHER_PROJECT, path.join(f.dataDir, "projects", OTHER_PROJECT, "sessions", "s2", "2025-01-01T00-00-00_s2.jsonl")); // valid other
    insertSession(db, "s3", DEFAULT_PROJECT_ID, null); // unmaterialized（normal）
    insertSession(db, "s1-dup", DEFAULT_PROJECT_ID, path.join(f.dataDir, "sessions", "s1", "2025-01-01T00-00-00_s1.jsonl")); // duplicate
    insertSession(db, "escape", DEFAULT_PROJECT_ID, path.join(f.dataDir, "..", "escape.jsonl")); // traversal → invalid
    insertSession(db, "s6-null", DEFAULT_PROJECT_ID, "   "); // 空白 → invalid
  } finally {
    db.close();
  }
  return f;
}

function capture(): { io: ReconcileJsonlCliIo; logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  return { logs, errs, io: { log: (line) => logs.push(line), error: (line) => errs.push(line) } };
}

function sidecars(f: Fixture): string[] {
  return readdirSync(f.dir).filter((name) => name.startsWith("pi-agent-server.db")).sort();
}

describe("WP4C reconcile CLI：默认 dry-run 只读（SQLite）", () => {
  it("分析计数正确、零写入、DB 字节指纹不变、无 WAL/SHM 伴生、可执行性恒 false", async () => {
    const f = await standardFixture();
    const before = readFileSync(f.dbPath);

    const { io, logs, errs } = capture();
    const exit = await runReconcileJsonlCli(["run"], { DB_PATH: f.dbPath, DATA_DIR: f.dataDir }, io);
    expect(exit).toBe(0);
    const report = JSON.parse(logs.join("\n")) as ReconcileReport & { status: string; dialect: string };
    expect(report.status).toBe("analyzed");
    expect(report.dialect).toBe("SQLite");
    expect(report.mode).toBe("dry-run");
    expect(report.executable).toBe(false);
    expect(report.filesystemNotScanned).toBe(true);
    expect(report.cannotDetect).toEqual({ orphanFile: false, lostFile: false, jsonlValidity: false });
    expect(report.references).toBe(6);
    expect(report.unmaterialized).toBe(1); // s3 null → normal，不是 issue
    expect(report.valid).toBe(2);
    expect(report.invalidReferences).toBe(2); // escape + 空白
    expect(report.duplicateReferences).toBe(1); // s1-dup 与 s1 同 canonical
    expect(report.issues.map((issue) => issue.code).sort()).toEqual(["duplicate_reference", "invalid_reference"]);
    for (const issue of report.issues) {
      for (const reference of issue.references) expect(reference).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(errs.join("\n")).toContain("只读 DB reference 分析");
    expect(errs.join("\n")).toContain("filesystemNotScanned");
    expect(errs.join("\n")).toContain("executable:false");

    // 字节指纹一致 + 无 -wal/-shm 伴生。
    expect(readFileSync(f.dbPath).equals(before)).toBe(true);
    expect(sidecars(f)).toEqual(["pi-agent-server.db"]);
    // 报告与 stderr 不泄露任何路径/URL/session id/prompt 内容。
    const allOutput = logs.join("\n") + errs.join("\n");
    for (const secret of [f.dir, f.dataDir, f.dbPath, ".jsonl", "sessions", "projects", "s1", "s1-dup", "escape", "postgres://", "title", "owner"]) {
      expect(allOutput).not.toContain(secret);
    }
  });

  it("显式 --dry-run 与默认一致；重复 --dry-run 拒绝（退出码 2）", async () => {
    const f = await standardFixture();
    const { io: ioA, logs: logsA } = capture();
    expect(await runReconcileJsonlCli(["run", "--dry-run"], { DB_PATH: f.dbPath, DATA_DIR: f.dataDir }, ioA)).toBe(0);
    expect((JSON.parse(logsA.join("\n")) as { valid: number }).valid).toBe(2);
    const { io: ioB, logs: logsB, errs: errsB } = capture();
    expect(await runReconcileJsonlCli(["run", "--dry-run", "--dry-run"], { DB_PATH: f.dbPath, DATA_DIR: f.dataDir }, ioB)).toBe(2);
    expect(logsB).toEqual([]);
    expect(errsB.join("\n")).toContain("只能出现一次");
  });
});

describe("WP4C reconcile CLI：DATA_DIR 纯字符串契约（不验证存在性）", () => {
  it("缺失 / 相对 / root：fail-closed 且不回显路径；不存在的绝对 DATA_DIR 合法", async () => {
    const f = fixture();
    await createReconcileDb(f);
    const env: StorageEnvironment = { DB_PATH: f.dbPath };
    for (const dataDir of [undefined, "relative/data", "/"]) {
      const { io, logs, errs } = capture();
      const exit = await runReconcileJsonlCli(["run"], dataDir === undefined ? env : { ...env, DATA_DIR: dataDir }, io);
      expect(exit).toBe(1);
      expect(logs).toEqual([]);
      const errText = errs.join("\n");
      expect(errText).toContain("RECONCILE_FAILED");
      if (typeof dataDir === "string" && dataDir !== "/") expect(errText).not.toContain(dataDir);
      expect(errText).not.toContain(f.dir);
      expect(existsSync(f.dbPath)).toBe(true); // 契约失败前置，DB 未被动过
    }
    // 不存在的绝对 DATA_DIR：分析是纯字符串绑定，正常运行（绝不创建/扫描目录）。
    const missingData = path.join(f.dir, "never-created");
    const { io, logs } = capture();
    const exit = await runReconcileJsonlCli(["run"], { DB_PATH: f.dbPath, DATA_DIR: missingData }, io);
    expect(exit).toBe(0);
    expect((JSON.parse(logs.join("\n")) as { status: string }).status).toBe("analyzed");
    expect(existsSync(missingData)).toBe(false); // 未创建任何目录
  });
});

describe("WP4C reconcile CLI：缺失 DB 零创建 / PG 门禁 / URL options", () => {
  it("DB_PATH 指向不存在的文件：退出非零且绝不创建 DB/WAL/SHM", async () => {
    const f = fixture();
    const missingDir = path.join(f.dir, "nowhere");
    // 不创建 missingDir：目录缺失时 DatabaseSync readOnly 同样 fail-closed。
    const missingDb = path.join(missingDir, "pi-agent-server.db");
    const { io, logs, errs } = capture();
    const exit = await runReconcileJsonlCli(["run"], { DB_PATH: missingDb, DATA_DIR: f.dataDir }, io);
    expect(exit).toBe(1);
    expect(logs).toEqual([]);
    expect(existsSync(missingDir)).toBe(false); // 目录未被创建，更无 DB/WAL/SHM
    expect(errs.join("\n")).not.toContain(missingDir);
  });

  it("无 DB_PATH 或相对 DB_PATH：fail-closed", async () => {
    const f = fixture();
    const { io: ioA, errs: errsA } = capture();
    expect(await runReconcileJsonlCli(["run"], { DATA_DIR: f.dataDir }, ioA)).toBe(1);
    expect(errsA.join("\n")).toContain("RECONCILE_FAILED");
    const { io: ioB, errs: errsB } = capture();
    expect(await runReconcileJsonlCli(["run"], { DB_PATH: "relative.db", DATA_DIR: f.dataDir }, ioB)).toBe(1);
    expect(errsB.join("\n")).not.toContain("relative.db");
  });

  it("无显式 PI_STORAGE_DIALECT=postgres + URL：fail-closed，不尝试连接", async () => {
    const f = fixture();
    const { io: ioA, logs: logsA } = capture();
    expect(await runReconcileJsonlCli(["run"], { PI_STORAGE_DIALECT: "postgres", DATA_DIR: f.dataDir }, ioA)).toBe(1);
    expect(logsA).toEqual([]);
    const { io: ioB, logs: logsB } = capture();
    expect(await runReconcileJsonlCli(["run"], { PI_DATABASE_URL: "postgresql://user:pass@host:1/db", DATA_DIR: f.dataDir }, ioB)).toBe(1);
    expect(logsB).toEqual([]);
  });

  it("URL 严格校验 + options 严格解析：仅 search_path 被接受并合并只读/lock，其余一律 fail-closed", async () => {
    // 干净 URL：追加只读 + lock 约束。
    expect(readOnlyReconcilePostgresUrl("postgresql://u:p@h:1/db")).toBe(
      "postgresql://u:p@h:1/db?options=-c+default_transaction_read_only%3Don+-c+lock_timeout%3D10000",
    );
    // search_path options：严格解析并保留（不丢弃），再合并只读/lock——这正是随机
    // schema 隔离的受支持路径。
    expect(readOnlyReconcilePostgresUrl("postgresql://u:p@h:1/db?options=-c+search_path%3Dpi_x")).toBe(
      "postgresql://u:p@h:1/db?options=-c+search_path%3Dpi_x+-c+default_transaction_read_only%3Don+-c+lock_timeout%3D10000",
    );
    // 其余任何 options / 形态一律 fail-closed（防注入、绝不透传、绝不降级为可写连接）。
    const rejected: Array<[string, string]> = [
      ["其他 GUC", "postgresql://u:p@h:1/db?options=-c+statement_timeout%3D1000"],
      ["用户自带只读", "postgresql://u:p@h:1/db?options=-c+default_transaction_read_only%3Don"],
      ["缺少 -c 前缀", "postgresql://u:p@h:1/db?options=search_path%3Dx"],
      ["search_path 两次", "postgresql://u:p@h:1/db?options=-c+search_path%3Da+-c+search_path%3Db"],
      ["search_path 无值", "postgresql://u:p@h:1/db?options=-c+search_path"],
      ["注入值（引号/分号）", "postgresql://u:p@h:1/db?options=-c+search_path%3D%22x%3B+DROP%22"],
      ["裸 token", "postgresql://u:p@h:1/db?options=--+foo"],
      ["重复 options 参数", "postgresql://u:p@h:1/db?options=-c+search_path%3Da&options=-c+search_path%3Db"],
    ];
    for (const [label, url] of rejected) {
      expect(() => readOnlyReconcilePostgresUrl(url), label).toThrow();
    }
    // 严格 URL 契约：协议 / host / database 显式、禁止 fragment、非法 port 解析失败。
    for (const url of [
      "ftp://u:p@h:1/db",
      "postgresql://u:p@h:1", // 无 database
      "postgresql://u:p@h:1/", // 空 database
      "postgresql://u:p@h:1/db/extra", // 多段 database
      "postgresql://u:p@h:1/db#fragment", // fragment 禁止
      "postgresql://u:p@h:abc/db", // 非法 port
      "not a url",
    ]) {
      expect(() => readOnlyReconcilePostgresUrl(url)).toThrow();
    }
    // 失败消息为稳定静态文本，绝不回显 URL/凭证。
    try {
      readOnlyReconcilePostgresUrl("postgresql://secret-user:secret-pass@h:1/db?options=-c+statement_timeout%3D1000");
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("secret-user");
      expect(message).not.toContain("secret-pass");
      expect(message).not.toContain("postgresql://");
      expect(message).not.toContain("statement_timeout");
    }
  });

  it("CLI 全链路：URL 含被拒 options / 非法协议 / fragment：连接前 fail-closed（退出 1、无输出 JSON、错误脱敏）", async () => {
    const f = fixture();
    const envs: StorageEnvironment[] = [
      { PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: "postgresql://u:p@h:1/db?options=-c+statement_timeout%3D1000", DATA_DIR: f.dataDir },
      { PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: "ftp://u:p@h:1/db", DATA_DIR: f.dataDir },
      { PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: "postgresql://u:p@h:1/db#frag", DATA_DIR: f.dataDir },
      { PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: "postgresql://u:p@h:1", DATA_DIR: f.dataDir },
      { PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: "postgresql://u:p@h:1/db?options=-c+search_path%3D%22x%3B+DROP%22", DATA_DIR: f.dataDir },
    ];
    for (const env of envs) {
      const { io, logs, errs } = capture();
      const exit = await runReconcileJsonlCli(["run"], env, io);
      expect(exit).toBe(1);
      expect(logs).toEqual([]);
      const errText = errs.join("\n");
      expect(errText).toContain("RECONCILE_FAILED");
      expect(errText).not.toContain("postgresql://");
      expect(errText).not.toContain("statement_timeout");
      expect(errText).not.toContain("search_path");
    }
  });

  it("CLI 源码级零 fs：主入口无 node:fs/realpath // 唯一必要 FS 是 SQLite 只读打开", async () => {
    const cliSource = readFileSync(new URL("../../scripts/reconcile-jsonl.ts", import.meta.url), "utf8");
    expect(cliSource).not.toMatch(/node:fs|node:child_process/);
    expect(cliSource).not.toMatch(/\b(?:realpathSync|lstatSync|statSync|readdirSync|readFileSync|openSync|mkdirSync|rmSync|writeFileSync|createReadStream)\b/);
    expect(cliSource).toContain("readOnly: true");
    expect(cliSource).toMatch(/纯 path\/fileURL 判断，零 fs/);
    const coreSource = readFileSync(new URL("../../src/file-operations/reconcile.ts", import.meta.url), "utf8");
    expect(coreSource).not.toMatch(/node:fs|node:child_process/);
    expect(coreSource).toContain('from "node:crypto"');
  });
});

describe("WP4C reconcile CLI：--apply / 未知参数 fail-closed", () => {
  it("--apply：退出码 2、零输出 JSON、零写入；确认词不可绕过", async () => {
    const f = await standardFixture();
    const before = readFileSync(f.dbPath);
    const { io, logs, errs } = capture();
    const exit = await runReconcileJsonlCli(["run", "--apply"], { DB_PATH: f.dbPath, DATA_DIR: f.dataDir }, io);
    expect(exit).toBe(2);
    expect(logs).toEqual([]);
    expect(errs.join("\n")).toContain("--apply 未实现");
    expect(errs.join("\n")).toContain("native helper");

    const { io: ioB, logs: logsB, errs: errsB } = capture();
    const exitB = await runReconcileJsonlCli(
      ["run", "--apply", "--confirm-maintenance", "EXECUTE_RECONCILE", "--maintenance-window", "CONFIRMED", "--quarantine-root", "/tmp/q"],
      { DB_PATH: f.dbPath, DATA_DIR: f.dataDir },
      ioB,
    );
    expect(exitB).toBe(2);
    expect(logsB).toEqual([]);
    expect(errsB.join("\n")).toContain("--apply 未实现");
    // 零写：DB 指纹不变。
    expect(readFileSync(f.dbPath).equals(before)).toBe(true);
  });

  it("未知/执行器参数：退出码 2，不回显原始 argv", async () => {
    const f = await standardFixture();
    const cases: Array<{ args: string[]; message: string }> = [
      { args: ["run", "--frobnicate"], message: "未知参数" },
      { args: ["run", "--limit", "5"], message: "未知参数" },
      { args: ["run", "--quarantine-root", "/tmp/secret-root"], message: "未知参数" },
      { args: ["run", "--confirm-reconcile", "YES"], message: "未知参数" },
      { args: ["bogus"], message: "用法：pnpm reconcile-jsonl" },
    ];
    for (const { args, message } of cases) {
      const { io, logs, errs } = capture();
      expect(await runReconcileJsonlCli(args, { DB_PATH: f.dbPath, DATA_DIR: f.dataDir }, io)).toBe(2);
      expect(logs).toEqual([]);
      const errText = errs.join("\n");
      expect(errText).toContain(message);
      expect(errText).not.toContain("frobnicate");
      expect(errText).not.toContain("secret-root");
      expect(errText).not.toContain("YES");
      expect(errText).not.toContain(f.dataDir);
    }
  });
});