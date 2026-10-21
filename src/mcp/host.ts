// MCP 宿主组合（docs/mcp-integration.md）：读取 Pi 的全局 mcp.json，按会话生成 MCP / codemode 扩展。
// 会话没有启用任何 server 时不加载 MCP 与 codemode 扩展，行为与未接入 MCP 一致。

import {
  createCodemodeExtension, createMcpExtension, type InlineExtension, type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import type { McpCatalog } from "./catalog.js";
import { CodemodeGate, createCodemodeAdmissionExtension } from "./codemode-admission.js";
import { LiveMcpCatalog } from "./live-catalog.js";
import { loadMcpTokenKeyFile, type McpTokenCipher } from "./token-cipher.js";
import { createHostMcpTransportFactory, DEFAULT_MAX_STDIO_PROCESSES, StdioProcessLimiter } from "./transport.js";

export interface McpHostOptions {
  /** Pi 的全局 mcp.json：`<agentDir>/mcp.json`（§14.2）。 */
  readonly piConfigPath: string;
  /** 用户 OAuth 凭证的加密密钥（PI_MCP_TOKEN_KEY_FILE）；没有时 mcp.json 里的 oauth server 不可用。 */
  readonly tokenKeyFile?: string;
  /** 配置了 PI_PUBLIC_URL：oauth server 还需要它才能让用户授权。 */
  readonly publicUrlConfigured?: boolean;
  /** mcp.json 读取失败或有项用不了时的提示。 */
  readonly warn?: (message: string) => void;
  readonly maxStdioProcesses?: number;
  readonly codemodeTimeoutMs?: number;
  readonly codemodeQueueWaitMs?: number;
  /** MCP server 日志（notifications/message）追加写入的文件。 */
  readonly logPath: string;
}

export interface McpHost {
  /** 运行中的目录：mcp.json 改了会跟着变；会话建连前先取快照。 */
  readonly catalog: LiveMcpCatalog;
  /** 配置了 PI_MCP_TOKEN_KEY_FILE 时才有。 */
  readonly tokenCipher?: McpTokenCipher;
  readonly limiter: StdioProcessLimiter;
  readonly gate: CodemodeGate;
  /**
   * 会话的 MCP 相关扩展；没有启用的 server 时为空，会话行为与未接入 MCP 一致。
   * `catalog` 是算出 `entries` 的那份快照，连接参数从它取，避免期间 mcp.json 被改。
   * `authProviderFor` 给出会话 owner 连接 oauth server 用的凭证（§13.9）。
   */
  sessionExtensions(catalog: McpCatalog, entries: readonly McpServerEntry[], options?: { authProviderFor?: (serverName: string) => AuthProvider | undefined }): InlineExtension[];
}

export function createMcpHost(options: McpHostOptions): McpHost {
  // SDK 接受的 timeout_ms 上限。
  if (options.codemodeTimeoutMs !== undefined && !(Number.isSafeInteger(options.codemodeTimeoutMs) && options.codemodeTimeoutMs > 0 && options.codemodeTimeoutMs <= 2_147_483_647)) {
    throw new Error("PI_CODEMODE_TIMEOUT_MS must be a positive integer up to 2147483647");
  }
  const tokenCipher = options.tokenKeyFile ? loadMcpTokenKeyFile(options.tokenKeyFile) : undefined;
  const catalog = new LiveMcpCatalog({
    piConfigPath: options.piConfigPath,
    context: { env: process.env, oauthEnabled: tokenCipher !== undefined && options.publicUrlConfigured === true },
    ...(options.warn ? { warn: options.warn } : {}),
  });
  const limiter = new StdioProcessLimiter(options.maxStdioProcesses ?? DEFAULT_MAX_STDIO_PROCESSES);
  const gate = new CodemodeGate();

  return {
    catalog, ...(tokenCipher ? { tokenCipher } : {}), limiter, gate,
    sessionExtensions(snapshot, entries, sessionOptions) {
      if (entries.length === 0) return [];
      const servers = [...entries];
      const createTransport = createHostMcpTransportFactory({
        catalog: snapshot, limiter, ...(sessionOptions?.authProviderFor ? { authProviderFor: sessionOptions.authProviderFor } : {}),
      });
      return [
        {
          name: "pi-agent-server-mcp",
          factory: createMcpExtension({
            // 只用宿主合成的配置：SDK 自己不读任何 mcp.json（全局 mcp.json 与信任项目的 .pi/mcp.json 由宿主解析后并入目录）。
            loadConfig: () => ({ servers, errors: [], autoEnableCodemode: true }),
            createTransport,
            logPath: options.logPath,
            // 服务端没有浏览器：用户在 Web 的 MCP 面板授权（§13.6），会话里不发起登录；/mcp 的修改不落盘。
            openUrl: () => { throw new Error("MCP OAuth sign-in happens in the Web MCP panel, not inside a session"); },
            updateConfig: () => {},
          }),
        },
        // models:false：脚本不能借服务端凭证调用模型目录与分类器。
        { name: "pi-agent-server-codemode", factory: createCodemodeExtension({ mode: "on", models: false }) },
        createCodemodeAdmissionExtension({
          gate,
          ...(options.codemodeTimeoutMs !== undefined ? { timeoutMs: options.codemodeTimeoutMs } : {}),
          ...(options.codemodeQueueWaitMs !== undefined ? { queueWaitMs: options.codemodeQueueWaitMs } : {}),
        }),
      ];
    },
  };
}
