// MCP 宿主组合（docs/mcp-integration.md）：启动时读取目录，按会话生成 MCP / codemode 扩展。
// 未配置 PI_MCP_CATALOG_FILE 时不创建，会话不加载任何 MCP 或 codemode 扩展。

import {
  createCodemodeExtension, createMcpExtension, type InlineExtension, type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import { loadMcpCatalogFiles, type McpCatalog, type McpSecrets } from "./catalog.js";
import { CodemodeGate, createCodemodeAdmissionExtension } from "./codemode-admission.js";
import { loadMcpTokenKeyFile, type McpTokenCipher } from "./token-cipher.js";
import { createHostMcpTransportFactory, DEFAULT_MAX_STDIO_PROCESSES, StdioProcessLimiter } from "./transport.js";

export interface McpHostOptions {
  readonly catalogFile: string;
  readonly secretsFile?: string;
  /** 用户 OAuth 凭证的加密密钥（PI_MCP_TOKEN_KEY_FILE）；目录里有 oauth server 时必填。 */
  readonly tokenKeyFile?: string;
  readonly maxStdioProcesses?: number;
  readonly codemodeTimeoutMs?: number;
  readonly codemodeQueueWaitMs?: number;
  /** MCP server 日志（notifications/message）追加写入的文件。 */
  readonly logPath: string;
}

export interface McpHost {
  readonly catalog: McpCatalog;
  readonly secrets: McpSecrets;
  /** 目录里有 oauth server 时才有。 */
  readonly tokenCipher?: McpTokenCipher;
  readonly limiter: StdioProcessLimiter;
  readonly gate: CodemodeGate;
  /**
   * 会话的 MCP 相关扩展；没有启用的 server 时为空，会话行为与未接入 MCP 一致。
   * `authProviderFor` 给出会话 owner 连接 oauth server 用的凭证（§13.9）。
   */
  sessionExtensions(entries: readonly McpServerEntry[], options?: { authProviderFor?: (serverName: string) => AuthProvider | undefined }): InlineExtension[];
}

export function createMcpHost(options: McpHostOptions): McpHost {
  // SDK 接受的 timeout_ms 上限。
  if (options.codemodeTimeoutMs !== undefined && !(Number.isSafeInteger(options.codemodeTimeoutMs) && options.codemodeTimeoutMs > 0 && options.codemodeTimeoutMs <= 2_147_483_647)) {
    throw new Error("PI_CODEMODE_TIMEOUT_MS must be a positive integer up to 2147483647");
  }
  const { catalog, secrets } = loadMcpCatalogFiles({
    catalogFile: options.catalogFile,
    ...(options.secretsFile ? { secretsFile: options.secretsFile } : {}),
  });
  const hasOAuth = [...catalog.servers.values()].some(server => server.oauth !== undefined);
  if (hasOAuth && !options.tokenKeyFile) throw new Error("MCP catalog has oauth servers, which need PI_MCP_TOKEN_KEY_FILE");
  const tokenCipher = options.tokenKeyFile ? loadMcpTokenKeyFile(options.tokenKeyFile) : undefined;
  const limiter = new StdioProcessLimiter(options.maxStdioProcesses ?? DEFAULT_MAX_STDIO_PROCESSES);
  const gate = new CodemodeGate();

  return {
    catalog, secrets, ...(tokenCipher ? { tokenCipher } : {}), limiter, gate,
    sessionExtensions(entries, sessionOptions) {
      if (entries.length === 0) return [];
      const servers = [...entries];
      const createTransport = createHostMcpTransportFactory({
        catalog, secrets, limiter, ...(sessionOptions?.authProviderFor ? { authProviderFor: sessionOptions.authProviderFor } : {}),
      });
      return [
        {
          name: "pi-agent-server-mcp",
          factory: createMcpExtension({
            // 只用宿主合成的配置：不读 ~/.pi/agent/mcp.json、<agentDir>/mcp.json 或项目 .pi/mcp.json。
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
