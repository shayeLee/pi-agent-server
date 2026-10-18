import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpCatalogFiles, loadMcpSecretsFile, parseMcpCatalog, resolveMcpPlaceholders } from "../../src/mcp/catalog.js";

const secrets = new Map([["DOCS_TOKEN", "t0ken"]]);

function catalog(servers: Record<string, unknown>) {
  return parseMcpCatalog({ version: 1, servers }, secrets);
}

describe("parseMcpCatalog", () => {
  it("parses stdio and HTTP servers with defaults", () => {
    const parsed = catalog({
      docs: { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${secret:DOCS_TOKEN}" }, description: "Docs", maxExposure: "direct", toolExposure: { search: "direct" }, defaultEnabled: true },
      "repo-tools": { command: "uvx", args: ["repo-tools", "--root", "${PROJECT_CWD}"], description: " Repo ", adminOnly: true },
    });
    expect(parsed.servers.get("docs")).toMatchObject({
      connection: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${secret:DOCS_TOKEN}" } },
      exposure: "codemode", maxExposure: "direct", toolExposure: { search: "direct" }, adminOnly: false, defaultEnabled: true,
    });
    expect(parsed.servers.get("repo-tools")).toMatchObject({
      connection: { type: "stdio", command: "uvx", args: ["repo-tools", "--root", "${PROJECT_CWD}"] },
      description: "Repo", exposure: "codemode", maxExposure: "codemode", adminOnly: true, defaultEnabled: false,
    });
  });

  it("parses oauth servers: DCR by default, pre-registered client as fallback", () => {
    const parsed = catalog({
      linear: { url: "https://mcp.linear.app/mcp", description: "Linear", oauth: { label: " Linear ", scope: "read" } },
      github: {
        url: "https://api.githubcopilot.com/mcp/", headers: { "X-MCP-Readonly": "true" }, description: "GitHub",
        oauth: { label: "GitHub", clientId: "Iv23abc", clientSecret: "${secret:DOCS_TOKEN}", authorizationServerMetadataUrl: "http://127.0.0.1:9000/meta" },
      },
    });
    expect(parsed.servers.get("linear")?.oauth).toEqual({ label: "Linear", scope: "read" });
    expect(parsed.servers.get("github")?.oauth).toEqual({
      label: "GitHub", clientId: "Iv23abc", clientSecret: "${secret:DOCS_TOKEN}", authorizationServerMetadataUrl: "http://127.0.0.1:9000/meta",
    });
    expect(parsed.servers.get("github")?.connection).toEqual({ type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { "X-MCP-Readonly": "true" } });
  });

  it.each([
    [{ a: { command: "x" } }, /description is required/],
    [{ a: { command: "x", description: "d", oauth: { label: "X" } } }, /only supported for HTTP servers/],
    [{ a: { url: "https://x", description: "d", oauth: {} } }, /oauth.label is required/],
    [{ a: { url: "https://x", description: "d", oauth: { label: "X", flow: "device" } } }, /unknown oauth field "flow"/],
    [{ a: { url: "https://x", description: "d", headers: { authorization: "Bearer ${secret:DOCS_TOKEN}" }, oauth: { label: "X" } } }, /must not set an Authorization header/],
    [{ a: { url: "https://x", description: "d", oauth: { label: "X", clientSecret: "${secret:DOCS_TOKEN}" } } }, /clientSecret requires oauth.clientId/],
    [{ a: { url: "https://x", description: "d", oauth: { label: "X", clientId: "c", clientSecret: "plain" } } }, /must be a \$\{secret:NAME\} reference/],
    [{ a: { url: "https://x", description: "d", oauth: { label: "X", clientId: "c", clientSecret: "${secret:MISSING}" } } }, /does not define/],
    [{ a: { url: "https://x", description: "d", oauth: { label: "X", authorizationServerMetadataUrl: "http://auth.example.com/meta" } } }, /https URL/],
    [{ a: { url: "https://x", description: "d", auth: { provider: "p" } } }, /unknown field "auth"/],
    [{ a: { command: "x", description: "d", enabled: false } }, /unknown field "enabled"/],
    [{ a: { command: "x", description: "d", env: { K: "${HOME}" } } }, /unsupported placeholder/],
    [{ a: { url: "https://x", description: "d", headers: { K: "${PROJECT_CWD}" } } }, /unsupported placeholder/],
    [{ a: { command: "x", description: "d", env: { K: "${secret:MISSING}" } } }, /does not define/],
    [{ a: { url: "https://x/${secret:DOCS_TOKEN}", description: "d" } }, /url must not contain placeholders/],
    [{ a: { command: "x", description: "d", exposure: "direct", maxExposure: "codemode" } }, /exceeds maxExposure/],
    [{ a: { command: "x", description: "d", toolExposure: { t: "direct" } } }, /exceeds maxExposure/],
    [{ a: { url: "ftp://x", description: "d" } }, /http or https URL/],
    [{ "bad name": { command: "x", description: "d" } }, /invalid server name/],
    [{ "a-b": { command: "x", description: "d" }, a_b: { command: "y", description: "d" } }, /differ only/],
  ])("rejects %j", (servers, message) => {
    expect(() => catalog(servers)).toThrow(message);
  });

  it("rejects unknown top-level fields and versions", () => {
    expect(() => parseMcpCatalog({ version: 2, servers: {} })).toThrow(/version must be 1/);
    expect(() => parseMcpCatalog({ version: 1, servers: {}, mcpServers: {} })).toThrow(/unknown top-level field/);
  });
});

describe("resolveMcpPlaceholders", () => {
  it("substitutes secrets and the project cwd", () => {
    expect(resolveMcpPlaceholders("${secret:DOCS_TOKEN}@${PROJECT_CWD}", { secrets, projectCwd: "/p" })).toBe("t0ken@/p");
    expect(() => resolveMcpPlaceholders("${secret:OTHER}", { secrets, projectCwd: "/p" })).toThrow("unresolved MCP placeholder");
  });
});

describe("catalog and secrets files", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("loads a private secrets file and rejects one readable by others", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-catalog-"));
    const secretsFile = join(dir, "secrets.json");
    writeFileSync(secretsFile, JSON.stringify({ DOCS_TOKEN: "t0ken" }));
    chmodSync(secretsFile, 0o644);
    expect(() => loadMcpSecretsFile(secretsFile)).toThrow(/chmod 600/);
    chmodSync(secretsFile, 0o600);
    const catalogFile = join(dir, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ version: 1, servers: { docs: { url: "https://x", description: "d", headers: { A: "${secret:DOCS_TOKEN}" } } } }));
    expect(loadMcpCatalogFiles({ catalogFile, secretsFile }).catalog.servers.has("docs")).toBe(true);
  });

  it("requires absolute paths and valid JSON", () => {
    expect(() => loadMcpCatalogFiles({ catalogFile: "catalog.json" })).toThrow(/absolute path/);
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-catalog-"));
    const catalogFile = join(dir, "catalog.json");
    writeFileSync(catalogFile, "{");
    expect(() => loadMcpCatalogFiles({ catalogFile })).toThrow(/not valid JSON/);
  });
});
