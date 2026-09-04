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
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import { createPostgresKysely, createPostgresPool } from "../src/storage/postgres-bootstrap.js";
import { enforceReadOnlyPostgresUrl } from "../src/storage/postgres-connection.js";
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

/** PostgreSQL 有界超时（毫秒）：connect/query/statement/lock 全部有界，防挂死。 */
export const FILE_OPS_CONNECT_TIMEOUT_MS = 10_000;
export const FILE_OPS_QUERY_TIMEOUT_MS = 15_000;
export const FILE_OPS_STATEMENT_TIMEOUT_MS = 15_000;
export const FILE_OPS_LOCK_TIMEOUT_MS = 10_000;

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
 * 强制 PostgreSQL 会话只读：严格校验连接串（协议/host/database 显式、禁止
 * fragment），options 只允许 search_path（严格解析，其余一律拒绝），并合并
 * default_transaction_read_only=on 与有界 lock_timeout——绝不降级为可写连接。
 */
export function readOnlyPostgresUrl(raw: string): string {
  return enforceReadOnlyPostgresUrl(raw, { lockTimeoutMs: FILE_OPS_LOCK_TIMEOUT_MS });
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
    // 有界超时：connect（连接建立）/ query（驱动侧单查询）/ statement（服务端
    // 单语句）/ lock（-c lock_timeout 已在 readOnlyPostgresUrl 合并）。
    pool = createPostgresPool(poolUrl, {
      connectionTimeoutMillis: FILE_OPS_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: FILE_OPS_QUERY_TIMEOUT_MS,
      statementTimeoutMs: FILE_OPS_STATEMENT_TIMEOUT_MS,
    });
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
  // 纯 path/fileURL 判断，零 fs：不 realpath、不 stat、不解析符号链接、不读取
  // 任何文件（SQLite 只读打开是本 CLI 唯一必要的文件系统访问）。
  const entry = process.argv[1];
  if (entry === undefined || entry === "") return false;
  // 1) argv[1] 字面解析到本文件（相对/绝对均可；pnpm/tsx/编译产物直跑）。
  if (path.resolve(entry) === fileURLToPath(import.meta.url)) return true;
  // 2) installed npm bin：argv[1] 是 node_modules/.bin 下的符号链接（不解析），
  //    按已知 bin 名 basename 匹配兜底。
  return FILE_OPS_ENTRY_BASENAMES.has(path.basename(entry));
}

/** 与入口文件对应的已知 basename（installed bin 名 / 源 / 编译入口）。 */
const FILE_OPS_ENTRY_BASENAMES = new Set([
  "pi-agent-server-file-ops", // package.json bin 名（.bin 符号链接）
  "file-ops.js", // compiled 入口
  "file-ops", // 源入口（tsx/直接 node 调用别名）
]);

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