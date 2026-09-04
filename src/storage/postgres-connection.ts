// WP4B/WP4C 离线 CLI（file-ops planner / reconcile analyzer）共享的 PostgreSQL
// 连接串与 options 严格校验：
//
// - 严格 URL 契约：协议必须是 postgres:// 或 postgresql://，host 与 database
//   必须显式存在（pathname 恰为一个 database 段），禁止 fragment；任何解析失败
//   立即 fail-closed（错误为稳定静态文本，绝不回显 URL/凭证）；
// - options 参数严格解析：只允许 search_path（`-c search_path=<schema 列表>`，
//   至多一次；值只接受未引用的标识符/逗号分隔列表）。其余任何选项（statement_
//   timeout、ssl 参数、自定义 GUC、`--` 注入等）一律拒绝——绝不把用户 options
//   原样透传，绝不降级为可写连接；
// - 合并只读约束：统一追加 `-c default_transaction_read_only=on`，并按调用方
//   要求合并 `-c lock_timeout=<ms>`（有界 lock 等待；connect/query/statement
//   的有界超时由池配置承担，见 postgres-bootstrap.createPostgresPool）；
// - 纯 URL/字符串处理：零 fs、零网络（不解析 DNS、不建立连接）。

/** 稳定静态错误类别（不带任何连接串/主机/数据库原文）。 */
export class PostgresConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresConnectionError";
  }
}

const POSTGRES_URL_REQUIREMENTS =
  "必须显式 postgres:// 或 postgresql:// 协议、非空 host、非空 database，且禁止 fragment";

/** search_path 值：未引用标识符（含 $）的逗号分隔列表；无引号/空白/其他字符。 */
const SEARCH_PATH_LIST = /^[A-Za-z_][A-Za-z0-9_$]*(?:,[A-Za-z_][A-Za-z0-9_$]*)*$/;

/**
 * 严格解析 PostgreSQL 连接串（URL 形态）。失败抛 PostgresConnectionError（稳定
 * 静态消息）。成功返回解析后的 URL（调用方仍可修改 search params）。
 */
export function requirePostgresConnectionUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PostgresConnectionError(`PostgreSQL 连接串不合法：${POSTGRES_URL_REQUIREMENTS}`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PostgresConnectionError(`PostgreSQL 连接串不合法：${POSTGRES_URL_REQUIREMENTS}`);
  }
  if (url.hostname === "") {
    throw new PostgresConnectionError(`PostgreSQL 连接串不合法：${POSTGRES_URL_REQUIREMENTS}`);
  }
  // pathname 必须恰为一个 database 段（`/db`；`/`、`/a/b`、空均拒绝）。
  if (!/^\/[^/]+$/.test(url.pathname)) {
    throw new PostgresConnectionError(`PostgreSQL 连接串不合法：${POSTGRES_URL_REQUIREMENTS}`);
  }
  if (url.hash !== "") {
    throw new PostgresConnectionError(`PostgreSQL 连接串不合法：${POSTGRES_URL_REQUIREMENTS}`);
  }
  return url;
}

/**
 * 严格解析 options 参数：只接受 `-c search_path=<schema 列表>`（至多一次；值必须
 * 是未引用标识符的逗号分隔列表），其余任何内容一律拒绝。返回 search_path 值
 * （无 options 时返回 null）。绝不回显用户输入（错误为稳定静态文本）。
 */
export function parseSearchPathOnlyOptions(options: string | null): string | null {
  if (options === null) return null;
  const trimmed = options.trim();
  if (trimmed === "") return null;
  const tokens = trimmed.split(/\s+/);
  let searchPath: string | null = null;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token !== "-c") {
      throw new PostgresConnectionError("PostgreSQL options 只接受 -c name=value 对（仅 search_path）");
    }
    const pair = tokens[index + 1];
    if (pair === undefined) {
      throw new PostgresConnectionError("PostgreSQL options 只接受 -c name=value 对（仅 search_path）");
    }
    index += 2;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(pair);
    if (match === null) {
      throw new PostgresConnectionError("PostgreSQL options 只接受 -c name=value 对（仅 search_path）");
    }
    const name = match[1]!.toLowerCase();
    if (name !== "search_path") {
      throw new PostgresConnectionError("PostgreSQL options 只允许 -c search_path=<schema>；其他选项一律拒绝");
    }
    if (searchPath !== null) {
      throw new PostgresConnectionError("PostgreSQL options 的 search_path 只能出现一次");
    }
    const value = match[2]!;
    if (!SEARCH_PATH_LIST.test(value)) {
      throw new PostgresConnectionError("PostgreSQL options 的 search_path 值必须是未引用的 schema 标识符列表（无引号/空白/特殊字符）");
    }
    searchPath = value;
  }
  return searchPath;
}

/**
 * 在原 URL 上合并只读/lock 约束：保留 search_path（严格解析）、追加
 * default_transaction_read_only=on 与可选 lock_timeout，并回写 options 参数。
 * options 存在但含任何非 search_path 内容 → fail-closed。
 */
export function mergeReadOnlyPostgresOptions(url: URL, lockTimeoutMs?: number): void {
  const optionParams = url.searchParams.getAll("options");
  if (optionParams.length > 1) {
    throw new PostgresConnectionError("PostgreSQL options 参数只能出现一次");
  }
  if (lockTimeoutMs !== undefined && (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0)) {
    throw new PostgresConnectionError("PostgreSQL lock_timeout 必须是正整数毫秒");
  }
  const searchPath = parseSearchPathOnlyOptions(optionParams[0] ?? null);
  const parts: string[] = [];
  if (searchPath !== null) parts.push(`-c search_path=${searchPath}`);
  parts.push("-c default_transaction_read_only=on");
  if (lockTimeoutMs !== undefined) parts.push(`-c lock_timeout=${lockTimeoutMs}`);
  url.searchParams.set("options", parts.join(" "));
}

/**
 * 对外统一入口：严格校验 URL → 严格解析 options（仅 search_path）→ 合并只读/lock
 * 约束 → 返回唯一合法的只读连接串。失败抛 PostgresConnectionError（稳定静态
 * 消息，调用方按既有脱敏边界处理）。
 */
export function enforceReadOnlyPostgresUrl(raw: string, options?: { readonly lockTimeoutMs?: number }): string {
  const url = requirePostgresConnectionUrl(raw);
  mergeReadOnlyPostgresOptions(url, options?.lockTimeoutMs);
  return url.toString();
}