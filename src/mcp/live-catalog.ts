// 运行中的目录（docs/mcp-integration.md §14.2）：agentDir 下 Pi 的全局 mcp.json。
// 每次读取目录时检查文件的修改时间和大小，变了就重新解析，所以 `pi mcp add` 之后的会话
// 不用重启服务就能用上。解析失败时继续用上一次读成功的内容。

import { readFileSync, statSync, type Stats } from "node:fs";
import type { McpCatalog, McpCatalogServer } from "./catalog.js";
import { parsePiMcpConfig, type PiMcpConfig, type PiMcpConfigContext, type PiMcpUnavailable } from "./pi-config.js";

const MAX_FILE_BYTES = 1024 * 1024;

export interface PiMcpConfigStatus {
  readonly path: string;
  /** 最近一次读取失败的原因；这时用的是上一次读成功的内容。 */
  readonly error?: string;
  readonly unavailable: readonly PiMcpUnavailable[];
}

export interface LiveMcpCatalogOptions {
  /** Pi 的全局 mcp.json；不存在时当作没有 server。 */
  readonly piConfigPath: string;
  readonly context: PiMcpConfigContext;
  readonly warn?: (message: string) => void;
}

/**
 * `servers` 每次读取都可能变化。会话要用同一份内容建连，所以先 `snapshot()`，再把快照交给会话。
 */
export class LiveMcpCatalog implements McpCatalog {
  readonly #options: LiveMcpCatalogOptions;
  #servers: ReadonlyMap<string, McpCatalogServer> = new Map();
  #signature: string | undefined;
  #status: PiMcpConfigStatus;

  constructor(options: LiveMcpCatalogOptions) {
    this.#options = options;
    this.#status = { path: options.piConfigPath, unavailable: [] };
  }

  get servers(): ReadonlyMap<string, McpCatalogServer> {
    this.#refresh();
    return this.#servers;
  }

  /** mcp.json 的读取状态。 */
  get piConfigStatus(): PiMcpConfigStatus {
    this.#refresh();
    return this.#status;
  }

  snapshot(): McpCatalog {
    return { servers: this.servers };
  }

  #refresh(): void {
    const path = this.#options.piConfigPath;
    let stat: Stats | undefined;
    let signature: string;
    try {
      stat = statSync(path);
      signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
      signature = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
    if (signature === this.#signature) return;
    if (signature === "unreadable") return this.#fail(`${path} cannot be read`, signature);
    this.#signature = signature;
    if (!stat) return this.#apply({ servers: [], unavailable: [] });
    let config: PiMcpConfig;
    try {
      if (!stat.isFile()) throw new Error(`${path} must be a regular file`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MiB`);
      let raw: unknown;
      // 不回显 JSON.parse 的原文片段：文件里可能有明文 token。
      try { raw = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error(`${path} is not valid JSON`); }
      config = parsePiMcpConfig(raw, this.#options.context);
    } catch (error) {
      return this.#fail(error instanceof Error ? error.message : String(error), signature);
    }
    this.#apply(config);
  }

  #fail(message: string, signature: string): void {
    this.#signature = signature;
    this.#status = { ...this.#status, error: message };
    this.#options.warn?.(`MCP: ${message}; keeping the servers read before`);
  }

  #apply(config: PiMcpConfig): void {
    this.#servers = new Map(config.servers.map(server => [server.name, server]));
    this.#status = { path: this.#options.piConfigPath, unavailable: config.unavailable };
    for (const item of config.unavailable) this.#options.warn?.(`MCP: mcp.json server "${item.name}" is not used: ${item.reason}`);
  }
}
