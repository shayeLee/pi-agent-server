// Pi 全局 mcp.json → 目录 server（docs/mcp-integration.md §14.2）。
// 文件由管理员用 `pi mcp add`、TUI 的 `/mcp` 或手工维护，格式是 Pi 的 `mcpServers`。逐项转换：
// 本服务支持不了的项（`!cmd`、`auth.provider`、缺环境变量……）记为不可用并写明原因，不影响其他项，
// 也不让整个文件失效。本服务专用的设置放在每一项的 `piAgentServer` 对象里，Pi 会原样保留。

import { homedir } from "node:os";
import { join } from "node:path";
import { exposureRank, MCP_EXPOSURES, type McpCatalogConnection, type McpCatalogOAuth, type McpCatalogServer, type McpExposure } from "./catalog.js";

export interface PiMcpUnavailable {
  readonly name: string;
  readonly reason: string;
}

export interface PiMcpConfig {
  readonly servers: readonly McpCatalogServer[];
  readonly unavailable: readonly PiMcpUnavailable[];
}

export interface PiMcpConfigContext {
  /** `${NAME}` 取值的环境；只用来检查变量是否设置，连接时再从服务进程环境读取。 */
  readonly env: NodeJS.ProcessEnv;
  /** 服务配置了 PI_MCP_TOKEN_KEY_FILE 与 PI_PUBLIC_URL，能让用户各自授权。 */
  readonly oauthEnabled: boolean;
}

/** 这一项进不了目录；原因会显示给管理员。 */
class Unavailable extends Error {}

function skip(reason: string): never {
  throw new Unavailable(reason);
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
const EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };
const EXTENSION_KEYS = ["adminOnly", "maxExposure", "defaultEnabled", "label"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exposureOf(value: unknown, where: string): McpExposure {
  const resolved = typeof value === "string" ? (EXPOSURE_ALIASES[value] ?? value) : value;
  if (typeof resolved !== "string" || !(MCP_EXPOSURES as readonly string[]).includes(resolved)) {
    skip(`${where} 必须是 ${MCP_EXPOSURES.join("、")} 之一`);
  }
  return resolved as McpExposure;
}

/** `~` 与 `~/…` 指主目录，与 Pi 一致。 */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

type Part = { readonly literal: string } | { readonly placeholder: string };

/**
 * 把 Pi 的配置值（`$NAME`、`${NAME}`，`$$` 与 `$!` 转义）换成目录的占位符写法：环境变量写成 `${env:NAME}`，
 * 连接时才取值。`allowProjectCwd` 时另外接受 `${PROJECT_CWD}`。
 * 以 `!` 开头的值在 Pi 里是 shell 命令，这里不支持。
 */
function convertValue(value: string, where: string, context: PiMcpConfigContext, allowProjectCwd: boolean): string {
  if (value.startsWith("!")) skip(`${where} 用了 !命令，仅 TUI 可用`);
  const parts: Part[] = [];
  const literal = (text: string) => parts.push({ literal: text });
  const env = (name: string) => {
    if (!context.env[name]) skip(`${where} 引用的环境变量 ${name} 没有设置`);
    parts.push({ placeholder: `\${env:${name}}` });
  };
  let index = 0;
  while (index < value.length) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) {
      literal(value.slice(index));
      break;
    }
    literal(value.slice(index, dollar));
    const next = value[dollar + 1];
    if (next === "$" || next === "!") {
      literal(next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", dollar + 2);
      if (end < 0) {
        literal("$");
        index = dollar + 1;
        continue;
      }
      const inner = value.slice(dollar + 2, end);
      if (inner === "PROJECT_CWD" && allowProjectCwd) {
        parts.push({ placeholder: "${PROJECT_CWD}" });
      } else if (ENV_NAME.test(inner)) {
        env(inner);
      } else {
        literal(value.slice(dollar, end + 1));
      }
      index = end + 1;
      continue;
    }
    const match = ENV_NAME_PREFIX.exec(value.slice(dollar + 1));
    if (match) {
      env(match[0]);
      index = dollar + 1 + match[0].length;
      continue;
    }
    literal("$");
    index = dollar + 1;
  }
  // 连接时只替换 `${…}`，所以字面量里不能出现它，否则会被误当成占位符。
  let text = "";
  let pending = "";
  for (const part of parts) {
    if ("literal" in part) {
      pending += part.literal;
      continue;
    }
    if (pending.includes("${")) skip(`${where} 含有字面的 \${，目前不支持`);
    text += pending + part.placeholder;
    pending = "";
  }
  if (pending.includes("${")) skip(`${where} 含有字面的 \${，目前不支持`);
  return text + pending;
}

/** command、args、cwd：Pi 只展开 `~`，不解析变量；这里额外允许 `${PROJECT_CWD}`（args、cwd）。 */
function convertPath(value: string, where: string, allowProjectCwd: boolean): string {
  const expanded = expandHome(value);
  const rest = allowProjectCwd ? expanded.replaceAll("${PROJECT_CWD}", "") : expanded;
  if (rest.includes("${")) skip(`${where} 含有不支持的 \${…}${allowProjectCwd ? "（只能用 ${PROJECT_CWD}）" : ""}`);
  return expanded;
}

function stringRecord(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every(item => typeof item === "string")) skip(`${where} 必须是字符串到字符串的映射`);
  return value as Record<string, string>;
}

function isSecureUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

interface Extension {
  readonly adminOnly: boolean;
  readonly defaultEnabled: boolean;
  readonly maxExposure?: McpExposure;
  readonly label?: string;
}

function parseExtension(raw: unknown): Extension {
  if (raw === undefined) return { adminOnly: false, defaultEnabled: false };
  if (!isRecord(raw)) skip("piAgentServer 必须是对象");
  for (const key of Object.keys(raw)) {
    if (!EXTENSION_KEYS.includes(key)) skip(`piAgentServer 里有未知字段 ${key}`);
  }
  for (const key of ["adminOnly", "defaultEnabled"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") skip(`piAgentServer.${key} 必须是 true 或 false`);
  }
  if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.trim() === "")) skip("piAgentServer.label 必须是非空字符串");
  return {
    adminOnly: raw.adminOnly === true,
    defaultEnabled: raw.defaultEnabled === true,
    ...(raw.maxExposure !== undefined ? { maxExposure: exposureOf(raw.maxExposure, "piAgentServer.maxExposure") } : {}),
    ...(typeof raw.label === "string" ? { label: raw.label.trim() } : {}),
  };
}

function parseOAuth(raw: unknown, name: string, extension: Extension, context: PiMcpConfigContext): McpCatalogOAuth {
  if (!isRecord(raw)) skip("oauth 必须是对象");
  if (!context.oauthEnabled) skip("需要每个用户自己授权，但服务没有配置 PI_MCP_TOKEN_KEY_FILE 和 PI_PUBLIC_URL");
  for (const key of ["clientId", "clientSecret", "scope"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") skip(`oauth.${key} 必须是字符串`);
  }
  if (raw.clientSecret !== undefined && !raw.clientId) skip("oauth.clientSecret 需要同时写 oauth.clientId");
  if (raw.authServerMetadataUrl !== undefined && (typeof raw.authServerMetadataUrl !== "string" || !isSecureUrl(raw.authServerMetadataUrl))) {
    skip("oauth.authServerMetadataUrl 必须是 https 地址（只有本机可以用 http）");
  }
  const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() : "";
  const scope = typeof raw.scope === "string" ? raw.scope.trim() : "";
  return {
    label: extension.label ?? name,
    ...(scope ? { scope } : {}),
    ...(clientId ? { clientId } : {}),
    ...(typeof raw.clientSecret === "string" ? { clientSecret: convertValue(raw.clientSecret, "oauth.clientSecret", context, false) } : {}),
    ...(typeof raw.authServerMetadataUrl === "string" ? { authorizationServerMetadataUrl: raw.authServerMetadataUrl } : {}),
  };
}

function parseEntry(name: string, raw: unknown, context: PiMcpConfigContext): McpCatalogServer {
  if (!SERVER_NAME.test(name)) skip("名称只能用字母、数字、_ 和 -");
  if (!isRecord(raw)) skip("必须是对象");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") skip("enabled 必须是 true 或 false");
  if (raw.enabled === false) skip("已在 mcp.json 里停用");
  const type = raw.type;
  if (type === "sse") skip("不支持旧的 SSE 传输，请改用 streamable HTTP 地址");
  const isHttp = typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http");
  const isStdio = !isHttp && typeof raw.command === "string" && (type === undefined || type === "stdio");
  if (!isHttp && !isStdio) skip("需要 command（stdio）或 url（HTTP）");
  const extension = parseExtension(raw.piAgentServer);

  const exposure = raw.exposure === undefined ? "codemode" : exposureOf(raw.exposure, "exposure");
  const toolExposure: Record<string, McpExposure> = {};
  if (raw.toolExposure !== undefined) {
    if (!isRecord(raw.toolExposure)) skip("toolExposure 必须是工具名到提供方式的映射");
    for (const [tool, value] of Object.entries(raw.toolExposure)) toolExposure[tool] = exposureOf(value, `toolExposure ${tool}`);
  }
  // 没写上限时取 exposure 与工具级设置里最宽的那个，Pi 里能用的设置在这里照样能用。
  const widest = [exposure, ...Object.values(toolExposure)].reduce((a, b) => exposureRank(b) > exposureRank(a) ? b : a);
  const maxExposure = extension.maxExposure ?? widest;
  if (exposureRank(widest) > exposureRank(maxExposure)) skip(`exposure 或 toolExposure 超过了 piAgentServer.maxExposure（${maxExposure}）`);
  if (raw.description !== undefined && typeof raw.description !== "string") skip("description 必须是字符串");
  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0))) skip("timeout 必须是正数（秒）");

  let connection: McpCatalogConnection;
  let oauth: McpCatalogOAuth | undefined;
  if (isHttp) {
    const url = raw.url as string;
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) skip("url 必须是 http 或 https 地址");
    // 会把 TUI 使用者的模型登录凭证发给所有用户。
    if (raw.auth !== undefined) skip("auth.provider 用的是 TUI 使用者的模型登录凭证，仅 TUI 可用");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.headers === undefined ? {} : stringRecord(raw.headers, "headers"))) {
      headers[key] = convertValue(value, `header ${key}`, context, false);
    }
    if (raw.oauth !== undefined) {
      // 两种凭证二选一（§13.4）。
      if (Object.keys(headers).some(key => key.toLowerCase() === "authorization")) skip("有 oauth 时不能再写 Authorization header");
      oauth = parseOAuth(raw.oauth, name, extension, context);
    }
    connection = { type: "http", url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  } else {
    const command = convertPath(raw.command as string, "command", false);
    if (command.trim() === "") skip("command 不能为空");
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every(arg => typeof arg === "string"))) skip("args 必须是字符串数组");
    const args = (raw.args as string[] | undefined)?.map((arg, index) => convertPath(arg, `args[${index}]`, true));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env === undefined ? {} : stringRecord(raw.env, "env"))) {
      env[key] = convertValue(value, `env ${key}`, context, true);
    }
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") skip("cwd 必须是字符串");
    connection = {
      type: "stdio", command,
      ...(args ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof raw.cwd === "string" ? { cwd: convertPath(raw.cwd, "cwd", true) } : {}),
    };
  }
  return {
    name, connection, ...(oauth ? { oauth } : {}),
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    exposure, maxExposure, toolExposure,
    ...(typeof raw.timeout === "number" ? { timeout: raw.timeout } : {}),
    adminOnly: extension.adminOnly,
    defaultEnabled: extension.defaultEnabled,
  };
}

/** 解析 mcp.json 的内容。文件整体形状不对时抛错；单项的问题记进 `unavailable`。 */
export function parsePiMcpConfig(raw: unknown, context: PiMcpConfigContext): PiMcpConfig {
  if (!isRecord(raw) || (raw.mcpServers !== undefined && !isRecord(raw.mcpServers))) {
    throw new Error('mcp.json must contain an object with an "mcpServers" object');
  }
  const servers: McpCatalogServer[] = [];
  const unavailable: PiMcpUnavailable[] = [];
  // SDK 的工具名把 `-` 换成 `_`，仅这两个字符不同的名称会撞名。
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(raw.mcpServers ?? {})) {
    try {
      const server = parseEntry(name, value, context);
      const clash = normalized.get(name.replaceAll("-", "_"));
      if (clash) skip(`和 ${clash} 只差 - 与 _，工具名会冲突`);
      normalized.set(name.replaceAll("-", "_"), name);
      servers.push(server);
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      unavailable.push({ name, reason: error.message });
    }
  }
  return { servers, unavailable };
}
