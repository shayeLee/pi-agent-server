// A small MCP server: just enough of the protocol for a tools-only server.
// Requests: initialize, ping, tools/list, tools/call. Notifications: notifications/cancelled.
import {
  JSON_RPC_ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpTransport,
} from "@earendil-works/pi-mcp";

export type ToolContext = { signal: AbortSignal };

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Returns the text the model reads. Throwing makes an `isError` result with the message. */
  run(args: Record<string, unknown>, context: ToolContext): Promise<string>;
};

export type McpServerOptions = {
  name: string;
  version: string;
  instructions?: string;
  tools: readonly ToolDefinition[];
};

/** A tool argument the caller got wrong; reported to the model as a tool error it can fix. */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}

export class McpServer {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly running = new Map<JsonRpcId, AbortController>();
  private transport: McpTransport | null = null;

  constructor(private readonly options: McpServerOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  async connect(transport: McpTransport): Promise<void> {
    this.transport = transport;
    transport.onMessage((message) => void this.handle(message));
    transport.onClose(() => {
      for (const controller of this.running.values()) controller.abort();
      this.running.clear();
    });
    await transport.start();
  }

  private async handle(message: JsonRpcMessage): Promise<void> {
    if (!("method" in message)) return; // a response; this server never sends requests
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled") {
        const id = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId;
        if (id !== undefined) this.running.get(id)?.abort();
      }
      return;
    }
    const { id, method, params } = message;
    try {
      const result = await this.dispatch(id, method, params);
      await this.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : JSON_RPC_ERROR_CODES.internalError;
      await this.send({ jsonrpc: "2.0", id, error: { code, message: errorMessage(error) } });
    }
  }

  private async dispatch(id: JsonRpcId, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.name, version: this.options.version },
          ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools.values()].map(({ name, description, inputSchema, annotations }) => ({
            name, description, inputSchema, ...(annotations ? { annotations } : {}),
          })),
        };
      case "tools/call":
        return this.callTool(id, params);
      default:
        throw new RpcError(JSON_RPC_ERROR_CODES.methodNotFound, `不支持的方法：${method}`);
    }
  }

  private async callTool(id: JsonRpcId, params: unknown): Promise<unknown> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    if (!tool) throw new RpcError(JSON_RPC_ERROR_CODES.invalidParams, `没有这个工具：${String(name)}`);
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      throw new RpcError(JSON_RPC_ERROR_CODES.invalidParams, "arguments 必须是对象");
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      const text = await tool.run((args ?? {}) as Record<string, unknown>, { signal: controller.signal });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
    } finally {
      this.running.delete(id);
    }
  }

  private async send(message: JsonRpcMessage): Promise<void> {
    try {
      await this.transport?.send(message);
    } catch {
      // The client is gone; nothing left to tell it.
    }
  }
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
