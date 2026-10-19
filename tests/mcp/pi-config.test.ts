import { homedir } from "node:os";
import { join } from "node:path";
import { StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";
import { parsePiMcpConfig, type PiMcpConfigContext } from "../../src/mcp/pi-config.js";
import { createHostMcpTransportFactory, StdioProcessLimiter } from "../../src/mcp/transport.js";

const context: PiMcpConfigContext = { env: { DOCS_TOKEN: "from-env", HOME: "/home/me" }, oauthEnabled: true };
const parse = (mcpServers: Record<string, unknown>, overrides: Partial<PiMcpConfigContext> = {}) => parsePiMcpConfig({ mcpServers }, { ...context, ...overrides });
const reasonOf = (mcpServers: Record<string, unknown>, overrides: Partial<PiMcpConfigContext> = {}) => {
  const { servers, unavailable } = parse(mcpServers, overrides);
  expect(servers).toEqual([]);
  return unavailable[0]?.reason;
};

describe("parsePiMcpConfig", () => {
  it("reads the servers pi mcp add writes, with the defaults of a catalog server", () => {
    const { servers, unavailable } = parse({
      docs: { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, description: "Docs" },
      fs: { command: "npx", args: ["-y", "server-filesystem", "~/notes"], cwd: "~" },
    });
    expect(unavailable).toEqual([]);
    expect(servers).toEqual([
      {
        name: "docs", description: "Docs", exposure: "codemode", maxExposure: "codemode", toolExposure: {}, adminOnly: false, defaultEnabled: false,
        connection: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${env:DOCS_TOKEN}" } },
      },
      {
        name: "fs", description: "", exposure: "codemode", maxExposure: "codemode", toolExposure: {}, adminOnly: false, defaultEnabled: false,
        connection: { type: "stdio", command: "npx", args: ["-y", "server-filesystem", join(homedir(), "notes")], cwd: homedir() },
      },
    ]);
  });

  it("takes adminOnly, defaultEnabled, maxExposure and the button label from piAgentServer", () => {
    const [server] = parse({
      linear: {
        url: "https://mcp.linear.app/mcp", exposure: "codemode-deferred", toolExposure: { list_teams: "direct" }, timeout: 30,
        oauth: { scope: "read" }, piAgentServer: { adminOnly: true, defaultEnabled: true, label: "Linear" },
      },
    }).servers;
    expect(server).toMatchObject({
      exposure: "codemode", toolExposure: { list_teams: "direct" }, maxExposure: "direct", timeout: 30, adminOnly: true, defaultEnabled: true,
      oauth: { label: "Linear", scope: "read" },
    });
    expect(reasonOf({ a: { url: "https://a.example.com", exposure: "direct", piAgentServer: { maxExposure: "codemode" } } })).toMatch(/超过/);
    expect(reasonOf({ a: { url: "https://a.example.com", piAgentServer: { secret: true } } })).toMatch(/未知字段 secret/);
  });

  it("keeps values that only TUI can resolve, or that would leak a credential, out of the catalog", () => {
    expect(reasonOf({ a: { url: "https://a.example.com", headers: { Authorization: "!op read op://vault/token" } } })).toMatch(/!命令/);
    expect(reasonOf({ a: { url: "https://a.example.com", auth: { provider: "anthropic" } } })).toMatch(/auth\.provider/);
    expect(reasonOf({ a: { command: "srv", env: { TOKEN: "$MISSING" } } })).toMatch(/环境变量 MISSING 没有设置/);
    expect(reasonOf({ a: { url: "https://a.example.com", oauth: {} } }, { oauthEnabled: false })).toMatch(/PI_MCP_TOKEN_KEY_FILE/);
    expect(reasonOf({ a: { url: "https://a.example.com", headers: { Authorization: "Bearer x" }, oauth: {} } })).toMatch(/Authorization/);
    expect(reasonOf({ a: { url: "https://a.example.com", enabled: false } })).toMatch(/停用/);
    expect(reasonOf({ a: { url: "https://a.example.com/sse", type: "sse" } })).toMatch(/SSE/);
  });

  it("converts Pi's escapes and refuses literal ${ that would be read as a placeholder", () => {
    const [server] = parse({ a: { command: "srv", args: ["${PROJECT_CWD}/x"], env: { PRICE: "$$5 $!", BOTH: "$DOCS_TOKEN-${DOCS_TOKEN}", CWD: "${PROJECT_CWD}" } } }).servers;
    expect(server!.connection).toMatchObject({ args: ["${PROJECT_CWD}/x"], env: { PRICE: "$5 !", BOTH: "${env:DOCS_TOKEN}-${env:DOCS_TOKEN}", CWD: "${PROJECT_CWD}" } });
    expect(reasonOf({ a: { command: "srv", env: { X: "$${NAME}" } } })).toMatch(/字面的/);
    expect(reasonOf({ a: { command: "srv", args: ["${OTHER}"] } })).toMatch(/PROJECT_CWD/);
  });

  it("reports one entry per problem and keeps the rest", () => {
    const { servers, unavailable } = parse({ "my-docs": { url: "https://a.example.com" }, my_docs: { url: "https://b.example.com" }, "bad name": {} });
    expect(servers.map(server => server.name)).toEqual(["my-docs"]);
    expect(unavailable.map(item => item.name)).toEqual(["my_docs", "bad name"]);
    expect(() => parsePiMcpConfig({ mcpServers: [] }, context)).toThrow(/mcpServers/);
    expect(parsePiMcpConfig({}, context)).toEqual({ servers: [], unavailable: [] });
  });

  it("resolves ${NAME} from the service environment only when connecting", () => {
    const catalog = { servers: new Map(parse({
      remote: { url: "https://a.example.com", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
      local: { command: process.execPath, env: { TOKEN: "${DOCS_TOKEN}" } },
    }).servers.map(server => [server.name, server])) };
    const entry = (name: string) => ({ name, config: { command: "ignored" }, source: "test" });
    const factory = createHostMcpTransportFactory({ catalog, limiter: new StdioProcessLimiter(1), env: { PATH: "/bin", DOCS_TOKEN: "now" } });
    expect((factory(entry("remote"), "/p", undefined) as StreamableHttpTransport).options.headers).toEqual({ Authorization: "Bearer now" });
    expect((factory(entry("local"), "/p", undefined) as StdioTransport).options.env).toEqual({ PATH: "/bin", TOKEN: "now" });
    const unset = createHostMcpTransportFactory({ catalog, limiter: new StdioProcessLimiter(1), env: { PATH: "/bin" } });
    expect(() => unset(entry("remote"), "/p", undefined)).toThrow(/DOCS_TOKEN is not set/);
  });
});
