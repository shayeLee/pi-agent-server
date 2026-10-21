// MCP 目录（docs/mcp-integration.md §4、§14.2）：共享 MCP 来自 agentDir 下 Pi 的全局 mcp.json，
// 由 pi-config.ts 逐项转换成这里的 McpCatalogServer；项目只能在目录范围内启用与收紧。
// 信任的项目另外读它的 .pi/mcp.json，合并成这个项目自己的目录（project-config.ts）。

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

/**
 * 按用户授权的 HTTP server（docs/mcp-integration.md §13.4）。默认动态注册客户端；
 * 写了 clientId 时改用部署者预注册的客户端。
 */
export interface McpCatalogOAuth {
  /** 面板按钮上的名字（“连接 Linear”）。 */
  readonly label: string;
  /** 申请的 scope；不写时由 SDK 从 401 挑战或资源元数据里取。 */
  readonly scope?: string;
  readonly clientId?: string;
  /** 可含 `${env:NAME}`，连接时替换。 */
  readonly clientSecret?: string;
  readonly authorizationServerMetadataUrl?: string;
}

export interface McpCatalogServer {
  readonly name: string;
  readonly connection: McpCatalogConnection;
  /** 只有 HTTP server 可以有；有它时凭证只来自用户授权。 */
  readonly oauth?: McpCatalogOAuth;
  readonly description: string;
  readonly exposure: McpExposure;
  readonly maxExposure: McpExposure;
  readonly toolExposure: Readonly<Record<string, McpExposure>>;
  /** 单次请求超时（秒），沿用 SDK 语义。 */
  readonly timeout?: number;
  readonly adminOnly: boolean;
  readonly defaultEnabled: boolean;
  /** 只在项目的目录里有：defined 是项目 .pi/mcp.json 定义的，overridden 是全局的、被项目文件改了默认设置。 */
  readonly projectFile?: "defined" | "overridden";
}

export interface McpCatalog {
  readonly servers: ReadonlyMap<string, McpCatalogServer>;
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const MAX_FILE_BYTES = 1024 * 1024;

/** 读取受限的配置文件：必须是绝对路径、普通文件（不跟随符号链接），且不超过 1 MiB。 */
export function readConfigFile(path: string, what: string, privateFile: boolean): string {
  if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path`);
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error(`${what} cannot be read`); }
  if (!stat.isFile()) throw new Error(`${what} must be a regular file (symbolic links are rejected)`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${what} is larger than 1 MiB`);
  if (privateFile && (stat.mode & 0o077) !== 0) throw new Error(`${what} must not be readable or writable by group or others (chmod 600)`);
  return readFileSync(path, "utf8");
}

/**
 * 连接时替换占位符：`${env:NAME}`（Pi 的 `$NAME` / `${NAME}`）从服务进程环境变量取值，
 * `${PROJECT_CWD}` 换成会话的项目目录。
 */
export function resolveMcpPlaceholders(value: string, context: { projectCwd: string; env?: NodeJS.ProcessEnv }): string {
  return value.replace(PLACEHOLDER, (_whole, inner: string) => {
    if (inner === "PROJECT_CWD") return context.projectCwd;
    if (inner.startsWith("env:")) {
      // 与 Pi 一致：空字符串按未设置处理。
      const env = (context.env ?? process.env)[inner.slice("env:".length)];
      if (env) return env;
      throw new Error(`MCP environment variable ${inner.slice("env:".length)} is not set`);
    }
    // 解析 mcp.json 时已经校验过，正常不会走到这里；拒绝连接而不是传出未替换的占位符。
    throw new Error("unresolved MCP placeholder");
  });
}
