#!/usr/bin/env node
// WP4B（方案 A）安全只读 planner CLI。
//
// 设计边界：
// - 只支持默认 / 显式 --dry-run 的只读计划：SQLite 以 readOnly 打开（目标不存在
//   绝不创建 DB/WAL/SHM）；PostgreSQL 连接强制 default_transaction_read_only=on；
// - --apply 立即 fail-closed（退出码 2）：WP4B 物理执行器未实施，本工具零 claim /
//   lease / complete / fail / 文件操作，且不存在任何确认词可以绕过；
// - 计划只来自持久 file_operations 记录（只读 list()）：不扫描文件系统、不生成操作；
// - 报告只含 counts/error codes，不含任何 relative/absolute 路径；错误输出经脱敏；
// - 不接入 startServer、不安装 timer/scheduler；真正执行需受审计的外部运维工具或
//   未来 native helper（单独事项）。

import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import { createPostgresKysely, createPostgresPool } from "../src/storage/postgres-bootstrap.js";
import { NodeSqliteAdapter } from "../src/storage/node-sqlite-adapter.js";
import { runPostgresMigrations, runSqliteMigrations } from "../src/storage/migration-engine.js";
import { KyselyFileOperationRepository } from "../src/storage/kysely-file-operation-repository.js";
import type { StorageEnvironment } from "../src/storage/storage-config.js";
import { planFileOperationBatch } from "../src/file-operations/planner.js";
import type { DatabaseSchema } from "../src/storage/db-schema.js";

/** --apply 的固定 fail-closed 消息（无任何确认词可绕过）。 */
export const FILE_OPS_APPLY_UNAVAILABLE =
  "用法：--apply 未实现：WP4B 物理执行器未实施，本工具是安全只读 planner，" +
  "零 claim/lease/complete/fail/文件操作；执行请使用受审计的外部运维工具或未来 native helper";

export interface FileOpsCliOptions {
  readonly mode: "dry-run" | "default";
}

const usage = "用法：pnpm file-ops -- run [--dry-run]\n本工具是安全只读 planner：只统计 file_operations，绝不执行/写入/扫描文件系统";

export function parseFileOpsArgs(args: readonly string[]): FileOpsCliOptions {
  const actual = args[0] === "--" ? args.slice(1) : args;
  if (actual.length === 0 || actual[0] !== "run") throw new Error(usage);
  let mode: FileOpsCliOptions["mode"] = "default";
  const seen = new Set<string>();
  const flag = (name: string): void => {
    if (seen.has(name)) throw new Error(`用法：${name} 只能出现一次`);
    seen.add(name);
  };
  for (const argument of actual.slice(1)) {
    if (argument === "--dry-run") {
      flag(argument);
      mode = "dry-run";
    } else if (argument === "--apply") {
      // 立即 fail-closed：物理执行器未实施，任何确认词/维护窗口词都无意义。
      throw new Error(FILE_OPS_APPLY_UNAVAILABLE);
    } else {
      // 旧执行器参数（--confirm-maintenance/--maintenance-window/--limit/
      // --max-attempts/--backoff-*/--lease-ms/--remove-empty-parents）一律拒绝：
      // 无确认词绕过、无执行选项。不回显原始 argv（未知值可能含路径/凭证）。
      throw new Error("用法：未知参数");
    }
  }
  return { mode };
}

function resolveDialect(environment: StorageEnvironment): "sqlite" | "postgres" {
  const raw = environment.PI_STORAGE_DIALECT?.trim();
  if (raw === undefined || raw === "") return "sqlite";
  const dialect = raw.toLowerCase();
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`file-ops: 未知存储方言 ${raw}（仅支持 sqlite / postgres）`);
  }
  return dialect;
}

/** SQLite planner 需要显式绝对 DB_PATH；readOnly 打开，缺失文件绝不创建。 */
function requireExplicitSqliteDbPath(environment: StorageEnvironment): string {
  const raw = environment.DB_PATH?.trim();
  if (!raw) throw new Error("file-ops: SQLite planner 需要显式绝对 DB_PATH");
  if (!path.isAbsolute(raw)) throw new Error("file-ops: 需要绝对 DB_PATH");
  return path.resolve(raw);
}

/** PostgreSQL planner 需要显式 PI_STORAGE_DIALECT=postgres 与 PI_DATABASE_URL。 */
function requireExplicitPostgresUrl(environment: StorageEnvironment): string {
  const raw = environment.PI_DATABASE_URL?.trim();
  if (!raw) throw new Error("file-ops: PostgreSQL planner 需要显式 PI_STORAGE_DIALECT=postgres 与 PI_DATABASE_URL");
  return raw;
}

/**
 * 强制 PostgreSQL 会话只读：给连接串追加 default_transaction_read_only=on。
 * 原 URL 已含 options 参数时拒绝合并（fail-closed），绝不降级为可写连接。
 */
export function readOnlyPostgresUrl(raw: string): string {
  const url = new URL(raw);
  if (url.searchParams.get("options") !== null) {
    throw new Error("file-ops: PI_DATABASE_URL 已含 options 连接参数；planner 拒绝合并，请移除后重试（强制 default_transaction_read_only=on）");
  }
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  return url.toString();
}

function redactFileOpsError(error: unknown): string {
  // 与既有离线 CLI 相同策略：除用法消息外只暴露稳定类别，绝不回显环境路径/URL/凭证。
  if (error instanceof Error && error.message.startsWith("用法：")) return error.message;
  return "file-ops error: FILE_OPS_FAILED";
}

export interface FileOpsCliIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** planner 每次成功运行后在 stderr 输出的人类可读边界说明（stdout 只有 JSON）。 */
export const FILE_OPS_PLANNER_NOTE =
  "[file-ops] 只读 planner：不 claim、不执行、不触碰文件；执行需受审计的外部运维工具或未来 native helper";

export async function runFileOpsCli(
  args: readonly string[],
  environment: StorageEnvironment,
  io: FileOpsCliIo = { log: (line) => console.log(line), error: (line) => console.error(line) },
): Promise<number> {
  let parsed: FileOpsCliOptions;
  try {
    parsed = parseFileOpsArgs(args);
  } catch (error) {
    io.error(`[file-ops] ${redactFileOpsError(error)}`);
    return error instanceof Error && error.message.startsWith("用法：") ? 2 : 1;
  }
  let dialect: "sqlite" | "postgres";
  try {
    dialect = resolveDialect(environment);
  } catch (error) {
    io.error(`[file-ops] ${redactFileOpsError(error)}`);
    return 1;
  }
  if (dialect === "sqlite") {
    let dbPath: string;
    try {
      dbPath = requireExplicitSqliteDbPath(environment);
    } catch (error) {
      io.error(`[file-ops] ${redactFileOpsError(error)}`);
      return 1;
    }
    let db: DatabaseSync;
    try {
      // readOnly：目标不存在时 node:sqlite 直接报错，绝不创建 DB/WAL/SHM。
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 10_000 });
    } catch (error) {
      io.error(`[file-ops] ${redactFileOpsError(error)}`);
      return 1;
    }
    try {
      await runSqliteMigrations(db, { mode: "verify" });
      const kysely = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: new NodeSqliteAdapter(db, false) }) });
      const store = new KyselyFileOperationRepository(kysely, "sqlite");
      const report = await planFileOperationBatch(store);
      io.log(JSON.stringify({ status: "planned", dialect: "SQLite", ...report }));
      io.error(FILE_OPS_PLANNER_NOTE);
      return 0;
    } catch (error) {
      io.error(`[file-ops] ${redactFileOpsError(error)}`);
      return 1;
    } finally {
      db.close();
    }
  }
  let poolUrl: string;
  let pool: ReturnType<typeof createPostgresPool>;
  try {
    poolUrl = readOnlyPostgresUrl(requireExplicitPostgresUrl(environment));
    pool = createPostgresPool(poolUrl);
  } catch (error) {
    io.error(`[file-ops] ${redactFileOpsError(error)}`);
    return 1;
  }
  try {
    const kysely = createPostgresKysely(pool);
    await runPostgresMigrations(kysely, { mode: "verify" });
    const store = new KyselyFileOperationRepository(kysely, "postgres");
    const report = await planFileOperationBatch(store);
    io.log(JSON.stringify({ status: "planned", dialect: "PostgreSQL", ...report }));
    io.error(FILE_OPS_PLANNER_NOTE);
    return 0;
  } catch (error) {
    io.error(`[file-ops] ${redactFileOpsError(error)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

function isCliEntry(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  void runFileOpsCli(process.argv.slice(2), process.env as StorageEnvironment).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // 最终兜底：任何未捕获异常只输出稳定类别，绝不回显 stack/URL/路径/凭证。
      console.error(`[file-ops] ${redactFileOpsError(error)}`);
      process.exitCode = 1;
    },
  );
}

export { redactFileOpsError };