import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpHost } from "../../src/mcp/host.js";
import { effectiveMcpServerEntries } from "../../src/mcp/project-settings.js";

describe("createMcpHost with oauth servers", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mcp-host-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function files() {
    const catalogFile = join(root, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ version: 1, servers: {
      linear: { url: "https://mcp.linear.app/mcp", description: "Linear", oauth: { label: "Linear", scope: "read" }, defaultEnabled: true },
      docs: { url: "https://docs.example.com/mcp", description: "Docs", defaultEnabled: true },
    } }));
    const tokenKeyFile = join(root, "token.key");
    writeFileSync(tokenKeyFile, randomBytes(32).toString("base64"));
    chmodSync(tokenKeyFile, 0o600);
    return { catalogFile, tokenKeyFile, logPath: join(root, "mcp.log") };
  }

  it("refuses to start without PI_MCP_TOKEN_KEY_FILE", () => {
    const { catalogFile, logPath } = files();
    expect(() => createMcpHost({ catalogFile, logPath })).toThrow(/PI_MCP_TOKEN_KEY_FILE/);
  });

  it("loads the token key and keeps oauth servers out of sessions until per-user credentials are wired in", () => {
    const host = createMcpHost(files());
    expect(host.tokenCipher).toBeDefined();
    expect(effectiveMcpServerEntries(host.catalog, []).map(entry => entry.name)).toEqual(["docs"]);
  });
});
