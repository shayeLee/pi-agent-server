import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";
import { parseMcpCatalog } from "../../src/mcp/catalog.js";
import { createHostMcpTransportFactory, StdioProcessLimiter } from "../../src/mcp/transport.js";

const secrets = new Map([["TOKEN", "s3cret"]]);
const catalog = parseMcpCatalog({
  version: 1,
  servers: {
    local: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)", "${PROJECT_CWD}"], env: { TOKEN: "${secret:TOKEN}" }, cwd: "sub", description: "Local" },
    remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${secret:TOKEN}" }, description: "Remote" },
  },
}, secrets);
const entry = (name: string) => ({ name, config: { command: "ignored" }, source: "test" });

describe("createHostMcpTransportFactory", () => {
  it("builds stdio transports from the catalog with a minimal environment", () => {
    const factory = createHostMcpTransportFactory({ catalog, secrets, limiter: new StdioProcessLimiter(1), env: { PATH: "/bin", PI_MODEL_API_KEY: "leak" } });
    const transport = factory(entry("local"), "/projects/a", undefined) as StdioTransport;
    expect(transport).toBeInstanceOf(StdioTransport);
    expect(transport.options).toMatchObject({
      command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)", "/projects/a"],
      cwd: "/projects/a/sub", env: { PATH: "/bin", TOKEN: "s3cret" }, inheritEnv: false,
    });
    expect(transport.options.env).not.toHaveProperty("PI_MODEL_API_KEY");
  });

  it("builds HTTP transports with resolved headers and rejects servers outside the catalog", () => {
    const factory = createHostMcpTransportFactory({ catalog, secrets, limiter: new StdioProcessLimiter(1) });
    const transport = factory(entry("remote"), "/projects/a", undefined) as StreamableHttpTransport;
    expect(transport).toBeInstanceOf(StreamableHttpTransport);
    expect(transport.options.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(() => factory(entry("other"), "/projects/a", undefined)).toThrow(/not in the catalog/);
  });

  it("caps running stdio processes across sessions and frees the slot on close", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-transport-"));
    const limiter = new StdioProcessLimiter(1);
    const factory = createHostMcpTransportFactory({ catalog, secrets, limiter });
    mkdirSync(join(cwd, "sub"));
    const first = factory(entry("local"), cwd, undefined);
    const second = factory(entry("local"), cwd, undefined);
    try {
      await first.start();
      expect(limiter.count).toBe(1);
      await expect(second.start()).rejects.toThrow(/PI_MCP_MAX_STDIO_PROCESSES/);
      await first.close();
      expect(limiter.count).toBe(0);
    } finally {
      await first.close();
      await second.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
