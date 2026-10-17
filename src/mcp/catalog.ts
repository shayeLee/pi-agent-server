// MCP 全局目录与密钥文件（docs/mcp-integration.md §4.1、§7）。
// 目录由管理员维护（PI_MCP_CATALOG_FILE），项目只能在目录范围内启用与收紧；
// 宿主从不读取任何 mcp.json。密钥（PI_MCP_SECRETS_FILE）只在建立连接时替换进子进程 env 与 HTTP header，
// 不进入 process.env，也不出现在交给 SDK 的配置对象里。

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type McpExposure = "direct" | "codemode" | "deferred" | "hidden";
export const MCP_EXPOSURES: readonly McpExposure[] = ["direct", "codemode", "deferred", "hidden"];

/** 收紧顺序：direct > codemode = deferred > hidden。 */
export function exposureRank(exposure: McpExposure): number {
  return exposure === "direct" ? 2 : exposure === "hidden" ? 0 : 1;
}

/** 交给 SDK 的连接配置（占位符原样保留，由宿主 transport 在连接时替换）。 */
export type McpCatalogConnection =
  | { readonly type: "stdio"; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string }
  | { readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> };

export interface McpCatalogServer {
  readonly name: string;
  readonly connection: McpCatalogConnection;
  readonly description: string;
  readonly exposure: McpExposure;
  readonly maxExposure: McpExposure;
  readonly toolExposure: Readonly<Record<string, McpExposure>>;
  /** 单次请求超时（秒），沿用 SDK 语义。 */
  readonly timeout?: number;
  readonly adminOnly: boolean;
  readonly defaultEnabled: boolean;
}

export interface McpCatalog {
  readonly servers: ReadonlyMap<string, McpCatalogServer>;
}

export type McpSecrets = ReadonlyMap<string, string>;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\$\{([^}]*)\}/g;
const COMMON_KEYS = ["type", "description", "exposure", "maxExposure", "toolExposure", "timeout", "adminOnly", "defaultEnabled"];
const STDIO_KEYS = [...COMMON_KEYS, "command", "args", "env", "cwd"];
const HTTP_KEYS = [...COMMON_KEYS, "url", "headers"];
const MAX_FILE_BYTES = 1024 * 1024;

function fail(message: string): never {
  throw new Error(`MCP catalog: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value);
}

function stringRecord(value: unknown, what: string): Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every(item => typeof item === "string")) fail(`${what} must map names to strings`);
  return { ...value } as Record<string, string>;
}

/**
 * 校验字符串里的占位符：只允许 `${secret:NAME}`（NAME 必须在密钥文件中）与可选的 `${PROJECT_CWD}`。
 * 其他 `${...}` 一律拒绝，避免把服务进程环境变量读进 MCP 子进程。
 */
function checkPlaceholders(value: string, what: string, secrets: McpSecrets, allowProjectCwd: boolean): void {
  for (const match of value.matchAll(PLACEHOLDER)) {
    const inner = match[1]!;
    if (inner === "PROJECT_CWD" && allowProjectCwd) continue;
    if (inner.startsWith("secret:")) {
      const name = inner.slice("secret:".length);
      if (!SECRET_NAME.test(name)) fail(`${what} has an invalid secret name "${name}"`);
      if (!secrets.has(name)) fail(`${what} references secret "${name}", which the secrets file does not define`);
      continue;
    }
    fail(`${what} has an unsupported placeholder "\${${inner}}" (use \${secret:NAME}${allowProjectCwd ? " or ${PROJECT_CWD}" : ""})`);
  }
}

function parseServer(name: string, raw: unknown, secrets: McpSecrets): McpCatalogServer {
  if (!SERVER_NAME.test(name)) fail(`invalid server name "${name}" (use letters, digits, "_" and "-")`);
  if (!isRecord(raw)) fail(`server "${name}" must be an object`);
  const where = `server "${name}"`;
  const isHttp = raw.type === "http" || (raw.type === undefined && "url" in raw);
  if (raw.type !== undefined && raw.type !== "stdio" && raw.type !== "http") fail(`${where}: type must be "stdio" or "http"`);
  const allowed = isHttp ? HTTP_KEYS : STDIO_KEYS;
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(`${where}: unknown field "${key}"`);
  }
  if (typeof raw.description !== "string" || raw.description.trim() === "") fail(`${where}: description is required`);
  const exposure = raw.exposure === undefined ? "codemode" : raw.exposure;
  if (!isExposure(exposure)) fail(`${where}: exposure must be one of ${MCP_EXPOSURES.join(", ")}`);
  const maxExposure = raw.maxExposure === undefined ? exposure : raw.maxExposure;
  if (!isExposure(maxExposure)) fail(`${where}: maxExposure must be one of ${MCP_EXPOSURES.join(", ")}`);
  if (exposureRank(exposure) > exposureRank(maxExposure)) fail(`${where}: exposure "${exposure}" exceeds maxExposure "${maxExposure}"`);
  const toolExposure: Record<string, McpExposure> = {};
  if (raw.toolExposure !== undefined) {
    if (!isRecord(raw.toolExposure)) fail(`${where}: toolExposure must map tool names to exposures`);
    for (const [tool, value] of Object.entries(raw.toolExposure)) {
      if (!isExposure(value)) fail(`${where}: toolExposure "${tool}" must be one of ${MCP_EXPOSURES.join(", ")}`);
      if (exposureRank(value) > exposureRank(maxExposure)) fail(`${where}: toolExposure "${tool}" exceeds maxExposure "${maxExposure}"`);
      toolExposure[tool] = value;
    }
  }
  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0))) fail(`${where}: timeout must be a positive number of seconds`);
  for (const key of ["adminOnly", "defaultEnabled"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") fail(`${where}: ${key} must be a boolean`);
  }

  let connection: McpCatalogConnection;
  if (isHttp) {
    if (typeof raw.url !== "string" || !URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol)) {
      fail(`${where}: url must be an http or https URL`);
    }
    if (raw.url.includes("${")) fail(`${where}: url must not contain placeholders; put credentials in headers`);
    const headers = raw.headers === undefined ? undefined : stringRecord(raw.headers, `${where} headers`);
    for (const [key, value] of Object.entries(headers ?? {})) checkPlaceholders(value, `${where} header "${key}"`, secrets, false);
    connection = { type: "http", url: raw.url, ...(headers ? { headers } : {}) };
  } else {
    if (typeof raw.command !== "string" || raw.command.trim() === "") fail(`${where}: stdio servers need a command (HTTP servers need a url)`);
    if (raw.command.includes("${")) fail(`${where}: command must not contain placeholders`);
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every(arg => typeof arg === "string"))) fail(`${where}: args must be an array of strings`);
    const args = raw.args as string[] | undefined;
    args?.forEach((arg, index) => checkPlaceholders(arg, `${where} args[${index}]`, secrets, true));
    const env = raw.env === undefined ? undefined : stringRecord(raw.env, `${where} env`);
    for (const [key, value] of Object.entries(env ?? {})) checkPlaceholders(value, `${where} env "${key}"`, secrets, true);
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") fail(`${where}: cwd must be a string`);
    if (typeof raw.cwd === "string") checkPlaceholders(raw.cwd, `${where} cwd`, secrets, true);
    connection = {
      type: "stdio", command: raw.command,
      ...(args ? { args: [...args] } : {}), ...(env ? { env } : {}), ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    };
  }
  return {
    name, connection, description: raw.description.trim(), exposure, maxExposure, toolExposure,
    ...(typeof raw.timeout === "number" ? { timeout: raw.timeout } : {}),
    adminOnly: raw.adminOnly === true,
    defaultEnabled: raw.defaultEnabled === true,
  };
}

/** 解析目录 JSON 值（严格：未知字段、非法 exposure、未定义的密钥都拒绝）。 */
export function parseMcpCatalog(raw: unknown, secrets: McpSecrets = new Map()): McpCatalog {
  if (!isRecord(raw)) fail("the file must contain a JSON object");
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "servers") fail(`unknown top-level field "${key}"`);
  }
  if (raw.version !== 1) fail("version must be 1");
  if (!isRecord(raw.servers)) fail("servers must be an object");
  const servers = new Map<string, McpCatalogServer>();
  // SDK 的工具名把 `-` 换成 `_`，仅这两个字符不同的名称会撞名。
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(raw.servers)) {
    const server = parseServer(name, value, secrets);
    const key = name.replaceAll("-", "_");
    const clash = normalized.get(key);
    if (clash) fail(`server names "${clash}" and "${name}" differ only in "-" and "_"`);
    normalized.set(key, name);
    servers.set(name, server);
  }
  return { servers };
}

/** 读取受限的配置文件：必须是绝对路径、普通文件（不跟随符号链接），且不超过 1 MiB。 */
function readConfigFile(path: string, what: string, privateFile: boolean): string {
  if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path`);
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error(`${what} cannot be read`); }
  if (!stat.isFile()) throw new Error(`${what} must be a regular file (symbolic links are rejected)`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${what} is larger than 1 MiB`);
  if (privateFile && (stat.mode & 0o077) !== 0) throw new Error(`${what} must not be readable or writable by group or others (chmod 600)`);
  return readFileSync(path, "utf8");
}

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error(`${what} is not valid JSON`); }
}

/** 密钥文件：`{ "NAME": "value" }`，权限必须是 0600（或更严）。错误信息从不回显值。 */
export function loadMcpSecretsFile(path: string): McpSecrets {
  const what = "PI_MCP_SECRETS_FILE";
  const raw = parseJson(readConfigFile(path, what, true), what);
  if (!isRecord(raw)) throw new Error(`${what} must contain a JSON object`);
  const secrets = new Map<string, string>();
  for (const [name, value] of Object.entries(raw)) {
    if (!SECRET_NAME.test(name)) throw new Error(`${what}: invalid secret name "${name}"`);
    if (typeof value !== "string") throw new Error(`${what}: secret "${name}" must be a string`);
    secrets.set(name, value);
  }
  return secrets;
}

/** 启动时读取目录与可选的密钥文件；任何错误都阻止启动。 */
export function loadMcpCatalogFiles(options: { catalogFile: string; secretsFile?: string }): { catalog: McpCatalog; secrets: McpSecrets } {
  const secrets = options.secretsFile ? loadMcpSecretsFile(options.secretsFile) : new Map<string, string>();
  const what = "PI_MCP_CATALOG_FILE";
  const catalog = parseMcpCatalog(parseJson(readConfigFile(options.catalogFile, what, false), what), secrets);
  return { catalog, secrets };
}

/** 连接时替换占位符。 */
export function resolveMcpPlaceholders(value: string, context: { secrets: McpSecrets; projectCwd: string }): string {
  return value.replace(PLACEHOLDER, (_whole, inner: string) => {
    if (inner === "PROJECT_CWD") return context.projectCwd;
    if (inner.startsWith("secret:")) {
      const secret = context.secrets.get(inner.slice("secret:".length));
      if (secret !== undefined) return secret;
    }
    // 目录已在启动时校验，正常不会走到这里；拒绝连接而不是传出未替换的占位符。
    throw new Error("unresolved MCP placeholder");
  });
}
