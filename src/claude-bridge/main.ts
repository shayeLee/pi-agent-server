#!/usr/bin/env node
// Claude Desktop ↔ pi-agent-server bridge: a stdio MCP server started by Claude Desktop.
// stdout carries MCP messages only; everything else goes to stderr.
import { BRIDGE_NAME, BRIDGE_VERSION, createBridge } from "./bridge.js";
import { BridgeConfigError, readBridgeConfig, type BridgeConfig } from "./config.js";
import { StdioServerTransport } from "./stdio-transport.js";

let config: BridgeConfig;
try {
  config = readBridgeConfig();
} catch (error) {
  process.stderr.write(`${error instanceof BridgeConfigError ? error.message : String(error)}\n`);
  process.exit(2);
}
const transport = new StdioServerTransport();
transport.onClose(() => process.exit(0));
transport.onError((error) => process.stderr.write(`收到无法解析的消息：${error.message}\n`));
await createBridge(config).connect(transport);
process.stderr.write(`${BRIDGE_NAME} ${BRIDGE_VERSION} 已启动，后端 ${config.baseUrl}\n`);
