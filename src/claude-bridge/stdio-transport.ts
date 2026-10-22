// Server side of the MCP stdio transport: one JSON-RPC message per line on stdin and stdout.
import { parseJsonRpcMessage, type JsonRpcMessage, type McpTransport } from "@earendil-works/pi-mcp";

type Listener<T> = (value: T) => void;

export class StdioServerTransport implements McpTransport {
  private readonly messageListeners = new Set<Listener<JsonRpcMessage>>();
  private readonly errorListeners = new Set<Listener<Error>>();
  private readonly closeListeners = new Set<() => void>();
  private buffer = "";
  private closed = false;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  async start(): Promise<void> {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => this.receive(chunk));
    this.input.on("end", () => void this.close());
    this.input.on("error", (error: Error) => this.emitError(error));
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve, reject) => {
      this.output.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  onMessage(listener: Listener<JsonRpcMessage>): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: Listener<Error>): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = parseJsonRpcMessage(JSON.parse(line));
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      for (const listener of this.messageListeners) listener(message);
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
