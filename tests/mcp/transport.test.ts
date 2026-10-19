import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";
import { catalogOf } from "./catalog-fixture.js";
import { createHostMcpTransportFactory, StdioProcessLimiter } from "../../src/mcp/transport.js";

const env = { PATH: "/bin", TOKEN: "s3cret", PI_MODEL_API_KEY: "leak" };
const catalog = catalogOf({
  local: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)", "${PROJECT_CWD}"], env: { TOKEN: "${TOKEN}" }, cwd: "sub", description: "Local" },
  remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, description: "Remote" },
}, env);
const entry = (name: string) => ({ name, config: { command: "ignored" }, source: "test" });

describe("createHostMcpTransportFactory", () => {
  it("builds stdio transports from the catalog with a minimal environment", () => {
    const factory = createHostMcpTransportFactory({ catalog, limiter: new StdioProcessLimiter(1), env });
    const transport = factory(entry("local"), "/projects/a", undefined) as StdioTransport;
    expect(transport).toBeInstanceOf(StdioTransport);
    expect(transport.options).toMatchObject({
      command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)", "/projects/a"],
      cwd: "/projects/a/sub", env: { PATH: "/bin", TOKEN: "s3cret" }, inheritEnv: false,
    });
    expect(transport.options.env).not.toHaveProperty("PI_MODEL_API_KEY");
  });

  it("builds HTTP transports with resolved headers and rejects servers outside the catalog", () => {
    const factory = createHostMcpTransportFactory({ catalog, limiter: new StdioProcessLimiter(1), env });
    const transport = factory(entry("remote"), "/projects/a", undefined) as StreamableHttpTransport;
    expect(transport).toBeInstanceOf(StreamableHttpTransport);
    expect(transport.options.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(() => factory(entry("other"), "/projects/a", undefined)).toThrow(/not in the catalog/);
  });

  it("connects oauth servers only with the session owner's auth provider", () => {
    const oauthCatalog = catalogOf({ linear: { url: "https://mcp.linear.app/mcp", description: "Linear", oauth: {}, piAgentServer: { label: "Linear" } } });
    const authProvider = { token: async () => "t" };
    const withOwner = createHostMcpTransportFactory({ catalog: oauthCatalog, limiter: new StdioProcessLimiter(1), authProviderFor: name => name === "linear" ? authProvider : undefined });
    expect((withOwner(entry("linear"), "/projects/a", undefined) as StreamableHttpTransport).options.authProvider).toBe(authProvider);
    const withoutOwner = createHostMcpTransportFactory({ catalog: oauthCatalog, limiter: new StdioProcessLimiter(1) });
    expect(() => withoutOwner(entry("linear"), "/projects/a", undefined)).toThrow(/needs the session owner's Linear authorization/);
  });

  it("caps running stdio processes across sessions and frees the slot on close", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-transport-"));
    const limiter = new StdioProcessLimiter(1);
    const factory = createHostMcpTransportFactory({ catalog, limiter, env });
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
