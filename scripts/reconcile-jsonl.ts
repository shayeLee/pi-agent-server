#!/usr/bin/env node
// WP4C（方案 A 收敛）安全只读 reconcile analyzer CLI。
//
// 设计边界：
// - 只支持默认 / 显式 --dry-run 的只读 DB reference 分析：SQLite 以 readOnly
//   打开（目标不存在绝不创建 DB/WAL/SHM）；PostgreSQL 连接强制
//   default_transaction_read_only=on；
// - **不触碰文件系统**：不递归遍历 DATA_DIR/sessions 或 DATA_DIR/projects，
//   不 lstat/open/readFile、不解析任何 JSONL；DATA_DIR 仅按纯字符串契约
//   （显式、绝对、非 root、无 traversal）参与规范布局绑定，不要求存在、不做
//   realpath；因此报告明确 filesystemNotScanned，**不能判定** orphan / lost /
//   JSONL 有效性；
// - --apply 立即 fail-closed（退出码 2）：WP4C 方案 A 零删除/移动/quarantine、
//   零 DB 写入、零 outbox enqueue、零 v2 migration，不存在任何确认词可以绕过；
// - DB 引用只经受控只读接口（session id/project id/pi_session_file 三字段），
//   绝不选取 title/system_prompt/cwd 等内容字段；migration 仅 verify（只读）；
// - 报告只含 counts / 固定 issue codes / opaque 引用（sha256），不含任何
//   relative/absolute 路径、DATA_DIR、URL、session id 或 prompt 内容；错误
//   输出经统一脱敏；
// - **CLI 主入口识别零 fs**：不 realpath/stat 任何文件——SQLite 只读打开
//   （node:sqlite）是本 CLI 唯一必要的文件系统访问，绝不扫描 DATA_DIR/JSONL；
//   主入口判断只用纯 path/fileURL 比较（相对/绝对字面等值 + 已知 bin 名兜底）；
// - PostgreSQL 连接串严格校验（协议/host/database 显式、禁止 fragment），
//   options 参数只允许 search_path（严格解析、其余一律拒绝），并合并只读/lock
//   约束与有界超时（connect/query/statement/lock）；
// - 输出明确 executable:false；真实 filesystem reconcile（探测 orphan/lost/
//   JSONL 损坏并处置）留给未来受审计的 native helper（单独事项）；
// - 不接入 startServer、不安装 timer/scheduler。

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import { createPostgresKysely, createPostgresPool } from "../src/storage/postgres-bootstrap.js";
import { enforceReadOnlyPostgresUrl } from "../src/storage/postgres-connection.js";
import { NodeSqliteAdapter } from "../src/storage/node-sqlite-adapter.js";
import { runPostgresMigrations, runSqliteMigrations } from "../src/storage/migration-engine.js";
import { KyselyReconcileReferenceRepository } from "../src/storage/kysely-reconcile-reference-repository.js";
import type { StorageEnvironment } from "../src/storage/storage-config.js";
import { analyzeReconcileReferences, requireReconcileDataDir, type ReconcileReport } from "../src/file-operations/reconcile.js";
import type { DatabaseSchema } from "../src/storage/db-schema.js";

/** --apply 的固定 fail-closed 消息（无任何确认词可绕过）。 */
export const RECONCILE_JSONL_APPLY_UNAVAILABLE =
  "用法：--apply 未实现：WP4C 方案 A 是安全只读 DB reference analyzer（executable:false），" +
  "零删除/移动/quarantine、零 DB 写入、零 outbox enqueue、零 v2 migration；" +
  "处置需使用受审计的外部运维工具或未来 native helper";

export interface ReconcileJsonlCliOptions {
  readonly mode: "dry-run" | "default";
}

/** PostgreSQL 有界超时（毫秒）：connect/query/statement/lock 全部有界，防挂死。 */
export const RECONCILE_JSONL_CONNECT_TIMEOUT_MS = 10_000;
export const RECONCILE_JSONL_QUERY_TIMEOUT_MS = 15_000;
export const RECONCILE_JSONL_STATEMENT_TIMEOUT_MS = 15_000;
export const RECONCILE_JSONL_LOCK_TIMEOUT_MS = 10_000;

const usage =
  "用法：pnpm reconcile-jsonl -- run [--dry-run]\n" +
  "本工具是安全只读 reconcile analyzer：只读 DB 引用 + 纯字符串规范布局绑定，绝不扫描文件系统、绝不执行/写入";

export function parseReconcileJsonlArgs(args: readonly string[]): ReconcileJsonlCliOptions {
  const actual = args[0] === "--" ? args.slice(1) : args;
  if (actual.length === 0 || actual[0] !== "run") throw new Error(usage);
  let mode: ReconcileJsonlCliOptions["mode"] = "default";
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
      // 立即 fail-closed：方案 A 不执行任何处置，任何确认词/维护窗口词都无意义。
      throw new Error(RECONCILE_JSONL_APPLY_UNAVAILABLE);
    } else if (argument.startsWith("--")) {
      // 未来执行器参数（--confirm-* / --maintenance-window / --limit /
      // --quarantine-* 等）一律拒绝：无执行选项、不 pretend 能执行。
      // 不回显原始 argv（未知值可能含路径/凭证）。
      throw new Error("用法：未知参数");
    } else {
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
    throw new Error(`reconcile-jsonl: 未知存储方言 ${raw}（仅支持 sqlite / postgres）`);
  }
  return dialect;
}

/** SQLite reconcile 需要显式绝对 DB_PATH；readOnly 打开，缺失文件绝不创建。 */
function requireExplicitSqliteDbPath(environment: StorageEnvironment): string {
  const raw = environment.DB_PATH?.trim();
  if (!raw) throw new Error("reconcile-jsonl: SQLite reconcile 需要显式绝对 DB_PATH");
  if (!path.isAbsolute(raw)) throw new Error("reconcile-jsonl: 需要绝对 DB_PATH");
  return path.resolve(raw);
}

/** PostgreSQL reconcile 需要显式 PI_STORAGE_DIALECT=postgres 与 PI_DATABASE_URL。 */
function requireExplicitPostgresUrl(environment: StorageEnvironment): string {
  const raw = environment.PI_DATABASE_URL?.trim();
  if (!raw) {
    throw new Error("reconcile-jsonl: PostgreSQL reconcile 需要显式 PI_STORAGE_DIALECT=postgres 与 PI_DATABASE_URL");
  }
  return raw;
}

/**
 * 强制 PostgreSQL 会话只读：严格校验连接串（协议/host/database 显式、禁止
 * fragment），options 只允许 search_path（严格解析，其余一律拒绝），并合并
 * default_transaction_read_only=on 与有界 lock_timeout——绝不降级为可写连接。
 */
export function readOnlyReconcilePostgresUrl(raw: string): string {
  return enforceReadOnlyPostgresUrl(raw, { lockTimeoutMs: RECONCILE_JSONL_LOCK_TIMEOUT_MS });
}

function redactReconcileError(error: unknown): string {
  // 统一脱敏边界：除静态用法消息外只暴露稳定类别，绝不回显环境路径/URL/凭证/
  // DB 内容（含 prompt 字段）或原始错误文本。
  if (error instanceof Error && error.message.startsWith("用法：")) return error.message;
  return "reconcile-jsonl error: RECONCILE_FAILED";
}

export interface ReconcileJsonlCliIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** 每次成功/失败运行后在 stderr 输出的人类可读边界说明（stdout 只有 JSON）。 */
export const RECONCILE_JSONL_NOTE =
  "[reconcile-jsonl] 只读 DB reference 分析：不扫描文件系统、不删除、不恢复、不写入任何内容；" +
  "不能判定 orphan/lost/JSONL 有效性（filesystemNotScanned），真实 filesystem reconcile 需未来 native helper（executable:false）";

export async function runReconcileJsonlCli(
  args: readonly string[],
  environment: StorageEnvironment,
  io: ReconcileJsonlCliIo = { log: (line) => console.log(line), error: (line) => console.error(line) },
): Promise<number> {
  let parsed: ReconcileJsonlCliOptions;
  try {
    parsed = parseReconcileJsonlArgs(args);
  } catch (error) {
    io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
    return error instanceof Error && error.message.startsWith("用法：") ? 2 : 1;
  }
  let dataDir: string;
  try {
    // DATA_DIR 纯字符串契约（显式、绝对、非 root、无 traversal）；不要求存在、
    // 不做 realpath——本分析绝不触碰文件系统。
    dataDir = requireReconcileDataDir(environment.DATA_DIR);
  } catch (error) {
    io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
    return 1;
  }
  let dialect: "sqlite" | "postgres";
  try {
    dialect = resolveDialect(environment);
  } catch (error) {
    io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
    return 1;
  }
  if (dialect === "sqlite") {
    let dbPath: string;
    try {
      dbPath = requireExplicitSqliteDbPath(environment);
    } catch (error) {
      io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
      return 1;
    }
    let db: DatabaseSync;
    try {
      // readOnly：目标不存在时 node:sqlite 直接报错，绝不创建 DB/WAL/SHM。
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 10_000 });
    } catch (error) {
      io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
      return 1;
    }
    try {
      // 迁移 head verify 只读：不 apply、不重置、不写 ledger。
      await runSqliteMigrations(db, { mode: "verify" });
      const kysely = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: new NodeSqliteAdapter(db, false) }) });
      const store = new KyselyReconcileReferenceRepository(kysely);
      const references = await store.listReconcileReferences();
      const report = await analyzeReconcileReferences(dataDir, references);
      return emitReconcileReport(report, "SQLite", io);
    } catch (error) {
      io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
      return 1;
    } finally {
      db.close();
    }
  }
  let poolUrl: string;
  let pool: ReturnType<typeof createPostgresPool>;
  try {
    poolUrl = readOnlyReconcilePostgresUrl(requireExplicitPostgresUrl(environment));
    // 有界超时：connect（连接建立）/ query（驱动侧单查询）/ statement（服务端
    // 单语句）/ lock（-c lock_timeout 已在 readOnlyReconcilePostgresUrl 合并）。
    pool = createPostgresPool(poolUrl, {
      connectionTimeoutMillis: RECONCILE_JSONL_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: RECONCILE_JSONL_QUERY_TIMEOUT_MS,
      statementTimeoutMs: RECONCILE_JSONL_STATEMENT_TIMEOUT_MS,
    });
  } catch (error) {
    io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
    return 1;
  }
  try {
    const kysely = createPostgresKysely(pool);
    // 迁移 head verify 只读（SET TRANSACTION … READ ONLY 与 read-only session 一致）。
    await runPostgresMigrations(kysely, { mode: "verify" });
    const store = new KyselyReconcileReferenceRepository(kysely);
    const references = await store.listReconcileReferences();
    const report = await analyzeReconcileReferences(dataDir, references);
    return emitReconcileReport(report, "PostgreSQL", io);
  } catch (error) {
    io.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

function emitReconcileReport(report: ReconcileReport, dialect: "SQLite" | "PostgreSQL", io: ReconcileJsonlCliIo): number {
  // stdout 只输出 JSON（含 status / dialect / 全部 counts / 固定 issue codes /
  // opaque 引用 / filesystemNotScanned）；绝不包含任何路径、URL、凭证或 prompt 内容。
  io.log(JSON.stringify({ ...report, dialect }));
  io.error(RECONCILE_JSONL_NOTE);
  return 0;
}

function isCliEntry(): boolean {
  // 纯 path/fileURL 判断，零 fs：不 realpath、不 stat、不解析符号链接、不读取
  // 任何文件（SQLite 只读打开是本 CLI 唯一必要的文件系统访问，绝不扫描
  // DATA_DIR/JSONL）。
  const entry = process.argv[1];
  if (entry === undefined || entry === "") return false;
  // 1) argv[1] 字面解析到本文件（相对/绝对均可；pnpm/tsx/编译产物直跑）。
  if (path.resolve(entry) === fileURLToPath(import.meta.url)) return true;
  // 2) installed npm bin：argv[1] 是 node_modules/.bin 下的符号链接（不解析），
  //    按已知 bin 名 basename 匹配兜底。
  return RECONCILE_JSONL_ENTRY_BASENAMES.has(path.basename(entry));
}

/** 与入口文件对应的已知 basename（installed bin 名 / 源 / 编译入口）。 */
const RECONCILE_JSONL_ENTRY_BASENAMES = new Set([
  "pi-agent-server-reconcile-jsonl", // package.json bin 名（.bin 符号链接）
  "reconcile-jsonl.js", // compiled 入口
  "reconcile-jsonl", // 源入口（tsx/直接 node 调用别名）
]);

if (isCliEntry()) {
  void runReconcileJsonlCli(process.argv.slice(2), process.env as StorageEnvironment).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // 最终兜底：任何未捕获异常只输出稳定类别，绝不回显 stack/URL/路径/凭证。
      console.error(`[reconcile-jsonl] ${redactReconcileError(error)}`);
      process.exitCode = 1;
    },
  );
}

export { redactReconcileError };