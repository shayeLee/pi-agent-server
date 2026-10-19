import type { McpCatalog } from "../../src/mcp/catalog.js";
import { parsePiMcpConfig } from "../../src/mcp/pi-config.js";

/** 按 mcp.json 的写法造目录；有一项用不了就直接报错，免得测试悄悄少了 server。 */
export function catalogOf(mcpServers: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): McpCatalog {
  const { servers, unavailable } = parsePiMcpConfig({ mcpServers }, { env, oauthEnabled: true });
  if (unavailable.length > 0) throw new Error(`unusable fixture: ${JSON.stringify(unavailable)}`);
  return { servers: new Map(servers.map(server => [server.name, server])) };
}
