// Minimal MCP stdio server for tests: newline-delimited JSON-RPC with one tool, `whoami`,
// which reports what the host passed to the process.
import { createInterface } from "node:readline";

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" },
      } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: request.id, result: { tools: [
        { name: "whoami", description: "Report the token, a leaked variable and the working directory", inputSchema: { type: "object", properties: {} } },
      ] } });
    case "tools/call":
      return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({
        token: process.env.FIXTURE_TOKEN ?? null, leaked: process.env.PI_MCP_TEST_SENTINEL ?? null, cwd: process.cwd(), arg: process.argv[2] ?? null,
      }) }] } });
    default:
      return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
});
