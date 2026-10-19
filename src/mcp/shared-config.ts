// admin 在 Web 上修改共享 MCP（docs/mcp-integration.md §14.3）：直接改 Pi 的全局 mcp.json。
// - 只改表单管得到的字段，文件里的其他内容（其他 server、toolExposure、Pi 自己的字段）原样保留。
// - 先写临时文件再改名；GET 给出文件内容的 hash，保存时对不上就是文件在别处（TUI、手工）被改过，拒绝覆盖。
// - header 与 env 的值打码返回，传回打码值表示不改。只引用环境变量的值（`Bearer ${TOKEN}`）不是凭证，照原样显示。

import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MCP_EXPOSURES, type McpExposure } from "./catalog.js";
import type { LiveMcpCatalog } from "./live-catalog.js";
import { parsePiMcpConfig } from "./pi-config.js";
import { SHARED_MCP_MASK, type SharedMcpList, type SharedMcpServer, type SharedMcpServerConfig } from "../shared/shared-mcp.js";

const MAX_FILE_BYTES = 1024 * 1024;
const ABSENT_HASH = "absent";
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** 只引用环境变量、可以照原样显示的值：`${TOKEN}`、`$TOKEN`、`Bearer ${TOKEN}`。 */
const ENV_REFERENCE_ONLY = /^(?:[A-Za-z][A-Za-z0-9-]{0,19} )?\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };
/** 表单管得到的字段；其余字段保存时原样保留。 */
const FORM_KEYS = new Set(["type", "url", "headers", "command", "args", "env", "cwd", "description", "exposure", "timeout", "enabled", "oauth", "piAgentServer"]);
const FORM_EXTENSION_KEYS = new Set(["adminOnly", "defaultEnabled", "maxExposure"]);

export type SharedMcpConfigErrorCode = "conflict" | "invalid" | "unknown_server";

export class SharedMcpConfigError extends Error {
  constructor(readonly code: SharedMcpConfigErrorCode, message: string) {
    super(message);
  }
}

export interface SharedMcpFileState {
  readonly path: string;
  readonly hash: string;
  /** 解析好的整个文件；文件不存在时是空对象，读不了时缺省。 */
  readonly config?: Record<string, unknown>;
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function maskValue(value: string): string {
  return value === "" || ENV_REFERENCE_ONLY.test(value) ? value : SHARED_MCP_MASK;
}

function maskRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const masked: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") masked[key] = maskValue(item);
  return masked;
}

function exposureOf(value: unknown): McpExposure | undefined {
  const resolved = typeof value === "string" ? (EXPOSURE_ALIASES[value] ?? value) : undefined;
  return resolved !== undefined && (MCP_EXPOSURES as readonly string[]).includes(resolved) ? resolved as McpExposure : undefined;
}

/** mcp.json 里的一项 → 表单（值已打码）与表单管不到的字段名。不是对象的项没有表单，只能删除。 */
export function sharedMcpForm(raw: unknown): { config: SharedMcpServerConfig; otherFields: string[] } | undefined {
  if (!isRecord(raw)) return undefined;
  const extension = isRecord(raw.piAgentServer) ? raw.piAgentServer : {};
  const oauth = isRecord(raw.oauth) ? raw.oauth : undefined;
  const http = typeof raw.url === "string";
  const headers = maskRecord(raw.headers);
  const env = maskRecord(raw.env);
  const exposure = exposureOf(raw.exposure);
  const maxExposure = exposureOf(extension.maxExposure);
  const config: SharedMcpServerConfig = {
    transport: http ? "http" : "stdio",
    ...(http ? { url: raw.url as string } : {}),
    ...(http && headers ? { headers } : {}),
    ...(!http && typeof raw.command === "string" ? { command: raw.command } : {}),
    ...(!http && Array.isArray(raw.args) ? { args: raw.args.filter((arg): arg is string => typeof arg === "string") } : {}),
    ...(!http && env ? { env } : {}),
    ...(!http && typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(exposure ? { exposure } : {}),
    ...(maxExposure ? { maxExposure } : {}),
    ...(extension.adminOnly === true ? { adminOnly: true } : {}),
    ...(extension.defaultEnabled === true ? { defaultEnabled: true } : {}),
    ...(typeof raw.timeout === "number" ? { timeout: raw.timeout } : {}),
    ...(raw.enabled === false ? { enabled: false } : {}),
    ...(http && oauth ? { oauth: typeof oauth.scope === "string" ? { scope: oauth.scope } : {} } : {}),
  };
  const otherFields = [
    ...Object.keys(raw).filter(key => !FORM_KEYS.has(key)),
    ...Object.keys(oauth ?? {}).filter(key => key !== "scope").map(key => `oauth.${key}`),
    ...Object.keys(extension).filter(key => !FORM_EXTENSION_KEYS.has(key)).map(key => `piAgentServer.${key}`),
  ];
  return { config, otherFields };
}

function invalid(message: string): never {
  throw new SharedMcpConfigError("invalid", message);
}

/** 打码值换回原值；新加的键不能是打码值。 */
function unmask(input: Readonly<Record<string, string>> | undefined, existing: unknown, what: string): Record<string, string> {
  const previous = isRecord(existing) ? existing : {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (key.trim() === "") invalid(`${what} 的名称不能为空`);
    if (value === SHARED_MCP_MASK) {
      if (typeof previous[key] !== "string") invalid(`${what} ${key} 没有填写值`);
      result[key] = previous[key] as string;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/** 表单 → mcp.json 里的一项：在原来那一项上改，表单管不到的字段保留。 */
export function applySharedMcpForm(existing: unknown, form: SharedMcpServerConfig): Record<string, unknown> {
  const previous = isRecord(existing) ? existing : {};
  const entry: Record<string, unknown> = structuredClone(previous);
  const wasHttp = typeof previous.url === "string";
  const http = form.transport === "http";
  // 换了传输方式就清掉另一种的字段；`type` 由 url / command 决定，不再需要。
  if (!isRecord(existing) || wasHttp !== http) {
    for (const key of ["type", "url", "headers", "oauth", "auth", "command", "args", "env", "cwd"]) delete entry[key];
  }
  if (http) {
    const url = form.url?.trim() ?? "";
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) invalid("地址必须是 http 或 https");
    entry.url = url;
    const headers = unmask(form.headers, previous.headers, "header");
    setOrDelete(entry, "headers", Object.keys(headers).length > 0 ? headers : undefined);
    if (form.oauth) {
      const oauth: Record<string, unknown> = isRecord(previous.oauth) ? structuredClone(previous.oauth) : {};
      setOrDelete(oauth, "scope", form.oauth.scope?.trim() || undefined);
      entry.oauth = oauth;
    } else {
      delete entry.oauth;
    }
  } else {
    const command = form.command?.trim() ?? "";
    if (command === "") invalid("命令不能为空");
    entry.command = command;
    setOrDelete(entry, "args", form.args && form.args.length > 0 ? [...form.args] : undefined);
    const env = unmask(form.env, previous.env, "环境变量");
    setOrDelete(entry, "env", Object.keys(env).length > 0 ? env : undefined);
    setOrDelete(entry, "cwd", form.cwd?.trim() || undefined);
  }
  setOrDelete(entry, "description", form.description?.trim() || undefined);
  setOrDelete(entry, "exposure", form.exposure && form.exposure !== "codemode" ? form.exposure : undefined);
  setOrDelete(entry, "timeout", form.timeout);
  setOrDelete(entry, "enabled", form.enabled === false ? false : undefined);
  const extension: Record<string, unknown> = isRecord(previous.piAgentServer) ? structuredClone(previous.piAgentServer) : {};
  setOrDelete(extension, "adminOnly", form.adminOnly ? true : undefined);
  setOrDelete(extension, "defaultEnabled", form.defaultEnabled ? true : undefined);
  setOrDelete(extension, "maxExposure", form.maxExposure);
  setOrDelete(entry, "piAgentServer", Object.keys(extension).length > 0 ? extension : undefined);
  return entry;
}

/** 环境变量都当作已设置、OAuth 当作可用：只检查写法，环境的问题留给列表里的“不可用”去提示。 */
const ANY_ENV = new Proxy({}, { get: () => "set" }) as NodeJS.ProcessEnv;

/** 检查一项能否写进文件：名称、和其他项的冲突，以及本服务能否读懂它。 */
export function validateSharedMcpEntry(name: string, entry: Record<string, unknown>, otherNames: readonly string[]): void {
  if (!SERVER_NAME.test(name)) invalid("名称只能用字母、数字、_ 和 -，最长 64 个字符");
  const clash = otherNames.find(other => other !== name && other.replaceAll("-", "_") === name.replaceAll("-", "_"));
  if (clash) invalid(`和 ${clash} 只差 - 与 _，工具名会冲突`);
  const { enabled: _enabled, ...rest } = entry;
  const { unavailable } = parsePiMcpConfig({ mcpServers: { [name]: rest } }, { env: ANY_ENV, oauthEnabled: true });
  if (unavailable[0]) invalid(unavailable[0].reason);
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 沿用文件原来的缩进；新文件用两个空格。 */
function indentOf(text: string): string {
  return /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
}

/** Pi 全局 mcp.json 的读写。同一进程里的写入排队执行。 */
export class SharedMcpConfigFile {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  read(): SharedMcpFileState & { readonly text?: string; readonly mode?: number } {
    const path = this.path;
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, hash: ABSENT_HASH, config: {} };
      return { path, hash: ABSENT_HASH, error: `${path} 读不了` };
    }
    if (stat.isSymbolicLink()) return { path, hash: ABSENT_HASH, error: `${path} 是符号链接，Web 上不能修改，请在终端里改` };
    if (!stat.isFile()) return { path, hash: ABSENT_HASH, error: `${path} 不是普通文件` };
    if (stat.size > MAX_FILE_BYTES) return { path, hash: ABSENT_HASH, error: `${path} 超过 1 MiB` };
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch { return { path, hash: ABSENT_HASH, error: `${path} 读不了` }; }
    const hash = hashOf(text);
    let config: unknown;
    // 不回显 JSON.parse 的原文片段：文件里可能有明文 token。
    try { config = JSON.parse(text); }
    catch { return { path, hash, text, error: `${path} 不是有效的 JSON` }; }
    if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
      return { path, hash, text, error: `${path} 里要有一个 "mcpServers" 对象` };
    }
    return { path, hash, text, config, mode: stat.mode & 0o777 };
  }

  /** 在文件内容的 hash 仍是 `expectedHash` 时修改 `mcpServers` 并写回。 */
  update(expectedHash: string, mutate: (servers: Record<string, unknown>) => void): Promise<void> {
    const run = this.#queue.then(() => this.#update(expectedHash, mutate));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #update(expectedHash: string, mutate: (servers: Record<string, unknown>) => void): void {
    const state = this.read();
    if (state.hash !== expectedHash) throw new SharedMcpConfigError("conflict", "配置文件已在别处修改，请刷新后再改");
    if (state.error || !state.config) invalid(`${state.error ?? "配置文件读不了"}；请先在终端里修好`);
    const config = state.config;
    const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
    mutate(servers);
    config.mcpServers = servers;
    this.#write(`${JSON.stringify(config, null, state.text ? indentOf(state.text) : "  ")}\n`, state.mode ?? 0o600);
  }

  /** 先写同目录的临时文件再改名，读的一方不会看到写了一半的文件。 */
  #write(text: string, mode: number): void {
    const temp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx", mode);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      rmSync(temp, { force: true });
      throw error;
    }
    closeSync(fd);
    try {
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

/** GET /v1/mcp/shared：按文件里的顺序列出每一项；admin 另外拿到表单、文件 hash 和读取错误。 */
export function sharedMcpList(file: SharedMcpConfigFile, catalog: LiveMcpCatalog, isAdmin: boolean): SharedMcpList {
  const state = file.read();
  const available = catalog.servers;
  const status = catalog.piConfigStatus;
  const reasons = new Map(status.unavailable.map(item => [item.name, item.reason]));
  const raw = state.config && isRecord(state.config.mcpServers) ? state.config.mcpServers : undefined;
  // 文件读不了时，按服务正在用的内容列出。
  const names = raw ? Object.keys(raw) : [...available.keys(), ...reasons.keys()];
  const servers: SharedMcpServer[] = [];
  for (const name of names) {
    const server = available.get(name);
    if (!server && !isAdmin) continue;
    const form = isAdmin && raw ? sharedMcpForm(raw[name]) : undefined;
    servers.push(server
      ? {
          name, status: "available", transport: server.connection.type, exposure: server.exposure, adminOnly: server.adminOnly,
          ...(server.description ? { description: server.description } : {}), ...(server.oauth ? { oauth: true } : {}),
          ...(form ? { config: form.config, otherFields: form.otherFields } : {}),
        }
      : {
          name, status: "unavailable", reason: reasons.get(name) ?? "等待重新读取",
          ...(form ? { transport: form.config.transport, config: form.config, otherFields: form.otherFields } : {}),
          ...(form?.config.description ? { description: form.config.description } : {}),
        });
  }
  const error = state.error ?? status.error;
  return {
    canEdit: isAdmin, servers,
    ...(isAdmin ? { file: { path: state.path, hash: state.hash, ...(error ? { error } : {}) } } : {}),
  };
}
