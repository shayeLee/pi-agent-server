// Wires the API client, turn tracker and tools into one MCP server.
import { ApiClient } from "../client/index.js";
import type { BridgeConfig } from "./config.js";
import { McpServer } from "./mcp-server.js";
import { createBridgeTools } from "./tools.js";
import { TurnTracker } from "./turns.js";

export const BRIDGE_NAME = "pi-agent-server-bridge";
export const BRIDGE_VERSION = "0.1.0";

export function createBridge(config: BridgeConfig, fetchImpl?: typeof globalThis.fetch): McpServer {
  const api = new ApiClient({ baseUrl: config.baseUrl, token: config.token, fetch: fetchImpl });
  const turns = new TurnTracker({
    api,
    baseUrl: config.baseUrl,
    headers: (): Record<string, string> => (config.token ? { authorization: `Bearer ${config.token}` } : {}),
    fetch: fetchImpl,
  });
  return new McpServer({
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    instructions: [
      `这些工具连着 pi-agent-server（${config.label}，${config.baseUrl}），可以把任务委派给 Pi 会话。`,
      "常见流程：pi_list_models 选模型 → pi_create_session 建会话 → pi_send 发任务；没跑完就用 pi_wait 接着等。",
      "Pi 会话能在项目目录里读写文件、执行命令，委派前把要求和边界写清楚。",
      "回复和记录都截断过，完整内容在 Web UI 查看（结果里有 webUrl 时给用户这个链接）。",
    ].join("\n"),
    tools: createBridgeTools({ api, config, turns }),
  });
}
