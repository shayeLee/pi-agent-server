import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpHost } from "../../src/mcp/host.js";
import { effectiveMcpServerEntries } from "../../src/mcp/project-settings.js";

describe("createMcpHost", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mcp-host-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function files() {
    const piConfigPath = join(root, "mcp.json");
    writeFileSync(piConfigPath, JSON.stringify({ mcpServers: {
      linear: { url: "https://mcp.linear.app/mcp", description: "Linear", oauth: { scope: "read" }, piAgentServer: { label: "Linear", defaultEnabled: true } },
      docs: { url: "https://docs.example.com/mcp", description: "Docs", piAgentServer: { defaultEnabled: true } },
    } }));
    const tokenKeyFile = join(root, "token.key");
    writeFileSync(tokenKeyFile, randomBytes(32).toString("base64"));
    chmodSync(tokenKeyFile, 0o600);
    return { piConfigPath, tokenKeyFile, logPath: join(root, "mcp.log") };
  }

  it("leaves oauth servers out until users can authorize, without refusing to start", () => {
    const { piConfigPath, tokenKeyFile, logPath } = files();
    for (const host of [createMcpHost({ piConfigPath, logPath }), createMcpHost({ piConfigPath, tokenKeyFile, logPath })]) {
      expect([...host.catalog.servers.keys()]).toEqual(["docs"]);
      expect(host.catalog.piConfigStatus.unavailable).toEqual([{ name: "linear", reason: expect.stringMatching(/PI_MCP_TOKEN_KEY_FILE 和 PI_PUBLIC_URL/) }]);
    }
  });

  it("loads the token key and lets an oauth server into a session only for a connected owner", () => {
    const host = createMcpHost({ ...files(), publicUrlConfigured: true });
    expect(host.tokenCipher).toBeDefined();
    expect(effectiveMcpServerEntries(host.catalog, []).map(entry => entry.name)).toEqual(["docs"]);
    expect(effectiveMcpServerEntries(host.catalog, [], new Set(["linear"])).map(entry => entry.name)).toEqual(["linear", "docs"]);
  });

  it("runs without mcp.json, offering no servers", () => {
    const host = createMcpHost({ piConfigPath: join(root, "missing.json"), logPath: join(root, "mcp.log") });
    expect(host.catalog.servers.size).toBe(0);
    expect(host.sessionExtensions(host.catalog.snapshot(), [])).toEqual([]);
  });
});
