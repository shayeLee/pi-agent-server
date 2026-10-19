// MCP 连接（docs/mcp-integration.md §7、§8）。
// SDK 的 McpClient 对每个 transport 单独 initialize，所以无法让多个会话共用同一个 MCP 会话；
// 这里按会话建连，但对 stdio 进程设全局上限，并让子进程只拿到最小环境变量 + 目录声明的变量。
// 不使用 SDK 默认 transport：它会继承服务进程 env，并执行 `!cmd`；`${NAME}` 由 pi-config.ts 转成 `${env:NAME}` 后在这里替换。

import { resolve } from "node:path";
import { StdioTransport, StreamableHttpTransport, type AuthProvider, type McpTransport } from "@earendil-works/pi-mcp";
import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { resolveMcpPlaceholders, type McpCatalog } from "./catalog.js";

/** 子进程从服务进程继承的最小环境变量集合（不含任何凭证）。 */
const INHERITED_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const;

export const DEFAULT_MAX_STDIO_PROCESSES = 32;

/** 进程级 stdio 名额：所有会话共享。 */
export class StdioProcessLimiter {
  private active = 0;
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("MCP stdio process limit must be a positive integer");
  }
  get count(): number { return this.active; }
  /** 取一个名额；已满时抛错（SDK 把它记为连接失败，不阻塞会话）。返回只生效一次的释放函数。 */
  acquire(server: string): () => void {
    if (this.active >= this.capacity) {
      throw new Error(`MCP server "${server}" was not started: the service already runs ${this.capacity} MCP processes (PI_MCP_MAX_STDIO_PROCESSES)`);
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}

/** 子类保持 `instanceof StdioTransport`，SDK 依赖它读取 stderr 与处理断线。 */
class LimitedStdioTransport extends StdioTransport {
  private release: (() => void) | undefined;
  constructor(options: ConstructorParameters<typeof StdioTransport>[0], private readonly limiter: StdioProcessLimiter, private readonly server: string) {
    super(options);
    this.onClose(() => this.release?.());
  }
  override async start(): Promise<void> {
    this.release = this.limiter.acquire(this.server);
    try {
      await super.start();
    } catch (error) {
      this.release();
      throw error;
    }
  }
  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      this.release?.();
    }
  }
}

function resolveRecord(record: Readonly<Record<string, string>> | undefined, context: { projectCwd: string; env?: NodeJS.ProcessEnv }): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) resolved[key] = resolveMcpPlaceholders(value, context);
  return resolved;
}

/**
 * 按目录（而不是 SDK 传入的配置）建立连接：项目设置只改 exposure，连接参数始终以目录为准。
 * 有 `oauth` 的 server 用 `authProviderFor` 给的会话 owner 凭证（§13.9）；拿不到就不连，
 * 其他 HTTP server 不带 authProvider，401 直接作为连接错误。
 */
export function createHostMcpTransportFactory(options: {
  catalog: McpCatalog;
  limiter: StdioProcessLimiter;
  env?: NodeJS.ProcessEnv;
  authProviderFor?: (serverName: string) => AuthProvider | undefined;
}): McpTransportFactory {
  const baseEnv: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = (options.env ?? process.env)[key];
    if (value !== undefined) baseEnv[key] = value;
  }
  return (entry, cwd): McpTransport => {
    const server = options.catalog.servers.get(entry.name);
    if (!server) throw new Error(`MCP server "${entry.name}" is not in the catalog`);
    const context = { projectCwd: cwd, ...(options.env ? { env: options.env } : {}) };
    const connection = server.connection;
    if (connection.type === "http") {
      const headers = resolveRecord(connection.headers, context);
      if (!server.oauth) return new StreamableHttpTransport({ url: connection.url, headers });
      const authProvider = options.authProviderFor?.(server.name);
      if (!authProvider) throw new Error(`MCP server "${server.name}" needs the session owner's ${server.oauth.label} authorization`);
      return new StreamableHttpTransport({ url: connection.url, headers, authProvider });
    }
    return new LimitedStdioTransport({
      command: connection.command,
      args: connection.args?.map(arg => resolveMcpPlaceholders(arg, context)),
      cwd: resolve(cwd, connection.cwd === undefined ? "." : resolveMcpPlaceholders(connection.cwd, context)),
      env: { ...baseEnv, ...resolveRecord(connection.env, context) },
      inheritEnv: false,
      stderr: "pipe",
    }, options.limiter, server.name);
  };
}
