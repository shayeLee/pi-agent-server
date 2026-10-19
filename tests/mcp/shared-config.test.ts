import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveMcpCatalog } from "../../src/mcp/live-catalog.js";
import {
  applySharedMcpForm, maskValue, SharedMcpConfigFile, sharedMcpForm, sharedMcpList, validateSharedMcpEntry,
} from "../../src/mcp/shared-config.js";
import { SHARED_MCP_MASK } from "../../src/shared/shared-mcp.js";

describe("shared MCP form", () => {
  it("masks credentials but shows values that only reference environment variables", () => {
    expect(maskValue("Bearer sk-live-123")).toBe(SHARED_MCP_MASK);
    expect(maskValue("plain")).toBe(SHARED_MCP_MASK);
    for (const value of ["${TOKEN}", "$TOKEN", "Bearer ${TOKEN}", "token $API_KEY", ""]) expect(maskValue(value)).toBe(value);
    expect(maskValue("Bearer ${TOKEN} extra")).toBe(SHARED_MCP_MASK);
  });

  it("reads an entry into the form and names the fields it leaves alone", () => {
    const form = sharedMcpForm({
      url: "https://mcp.linear.app/mcp", headers: { "X-Key": "secret", "X-Env": "${KEY}" }, exposure: "codemode-deferred",
      toolExposure: { a: "direct" }, oauth: { scope: "read", clientId: "c" }, piAgentServer: { maxExposure: "direct", label: "Linear", adminOnly: true },
    });
    expect(form).toEqual({
      config: {
        transport: "http", url: "https://mcp.linear.app/mcp", headers: { "X-Key": SHARED_MCP_MASK, "X-Env": "${KEY}" },
        exposure: "codemode", maxExposure: "direct", adminOnly: true, oauth: { scope: "read" },
      },
      otherFields: ["toolExposure", "oauth.clientId", "piAgentServer.label"],
    });
    expect(sharedMcpForm("broken")).toBeUndefined();
  });

  it("changes only what the form covers and keeps masked values", () => {
    const existing = {
      url: "https://a.example.com/mcp", headers: { Authorization: "Bearer secret", "X-Old": "x" }, toolExposure: { a: "hidden" },
      piAgentServer: { label: "A", defaultEnabled: true }, lifecycle: "eager",
    };
    const entry = applySharedMcpForm(existing, {
      transport: "http", url: " https://b.example.com/mcp ", headers: { Authorization: SHARED_MCP_MASK }, description: "  B  ",
      exposure: "codemode", maxExposure: "direct", timeout: 30,
    });
    expect(entry).toEqual({
      url: "https://b.example.com/mcp", headers: { Authorization: "Bearer secret" }, toolExposure: { a: "hidden" },
      piAgentServer: { label: "A", maxExposure: "direct" }, lifecycle: "eager", description: "B", timeout: 30,
    });
    expect(existing.headers.Authorization).toBe("Bearer secret");
    expect(() => applySharedMcpForm(existing, { transport: "http", url: "https://a.example.com", headers: { New: SHARED_MCP_MASK } })).toThrow(/New 没有填写/);
  });

  it("drops the other transport's fields when the transport changes", () => {
    const entry = applySharedMcpForm({ url: "https://a.example.com", headers: { A: "b" }, oauth: {}, auth: { provider: "x" }, description: "d" }, {
      transport: "stdio", command: "npx", args: ["-y", "srv"], env: { TOKEN: "${TOKEN}" }, cwd: "", enabled: false,
    });
    expect(entry).toEqual({ command: "npx", args: ["-y", "srv"], env: { TOKEN: "${TOKEN}" }, enabled: false });
    expect(applySharedMcpForm(undefined, { transport: "http", url: "https://a.example.com", oauth: { scope: "" } })).toEqual({ url: "https://a.example.com", oauth: {} });
    expect(() => applySharedMcpForm(undefined, { transport: "stdio", command: " " })).toThrow(/命令不能为空/);
    expect(() => applySharedMcpForm(undefined, { transport: "http", url: "ftp://a" })).toThrow(/http 或 https/);
  });

  it("refuses entries this server cannot use, but not ones that only miss an environment variable", () => {
    expect(() => validateSharedMcpEntry("bad name", { command: "srv" }, [])).toThrow(/名称/);
    expect(() => validateSharedMcpEntry("my_docs", { command: "srv" }, ["my-docs"])).toThrow(/只差/);
    expect(() => validateSharedMcpEntry("a", { url: "https://a.example.com", exposure: "direct", piAgentServer: { maxExposure: "codemode" } }, [])).toThrow(/超过/);
    expect(() => validateSharedMcpEntry("a", { command: "srv", env: { T: "!pass show t" } }, [])).toThrow(/!命令/);
    expect(() => validateSharedMcpEntry("a", { url: "https://a.example.com", headers: { Authorization: "Bearer ${UNSET_TOKEN}" }, enabled: false }, [])).not.toThrow();
  });
});

describe("SharedMcpConfigFile", () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-shared-"));
    path = join(root, "mcp.json");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("creates the file private and keeps other content and indentation", async () => {
    const file = new SharedMcpConfigFile(path);
    const empty = file.read();
    expect(empty).toMatchObject({ hash: "absent", config: {} });
    await file.update(empty.hash, servers => { servers.docs = { url: "https://docs.example.com" }; });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { docs: { url: "https://docs.example.com" } } });

    writeFileSync(path, '{\n    "settings": { "x": 1 },\n    "mcpServers": { "keep": { "command": "srv" } }\n}\n');
    await file.update(file.read().hash, servers => { servers.docs = { url: "https://docs.example.com" }; });
    const text = readFileSync(path, "utf8");
    expect(text.startsWith('{\n    "settings"')).toBe(true);
    expect(JSON.parse(text)).toEqual({ settings: { x: 1 }, mcpServers: { keep: { command: "srv" }, docs: { url: "https://docs.example.com" } } });
  });

  it("refuses to overwrite a file changed elsewhere, or one it cannot read", async () => {
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));
    const file = new SharedMcpConfigFile(path);
    const { hash } = file.read();
    writeFileSync(path, JSON.stringify({ mcpServers: { tui: { command: "srv" } } }));
    await expect(file.update(hash, () => {})).rejects.toMatchObject({ code: "conflict" });
    writeFileSync(path, '{"mcpServers": {"a": {"headers": {"Authorization": "Bearer sk-secret"');
    const broken = file.read();
    expect(broken.error).toMatch(/不是有效的 JSON/);
    await expect(file.update(broken.hash, () => {})).rejects.toMatchObject({ code: "invalid" });
    expect(JSON.stringify(broken)).not.toContain("sk-secret\"");

    const target = join(root, "real.json");
    writeFileSync(target, "{}");
    rmSync(path);
    symlinkSync(target, path);
    expect(file.read().error).toMatch(/符号链接/);
  });

  it("lists servers in file order, with the details only admins see", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: {
      tui: { url: "https://a.example.com", auth: { provider: "anthropic" } },
      docs: { url: "https://docs.example.com", headers: { "X-Key": "secret" }, description: "Docs" },
    } }));
    const catalog = new LiveMcpCatalog({ piConfigPath: path, context: { env: {}, oauthEnabled: false } });
    const file = new SharedMcpConfigFile(path);
    const forUser = sharedMcpList(file, catalog, false);
    expect(forUser).toEqual({ canEdit: false, servers: [{ name: "docs", status: "available", transport: "http", exposure: "codemode", adminOnly: false, description: "Docs" }] });
    const forAdmin = sharedMcpList(file, catalog, true);
    expect(forAdmin.file).toEqual({ path, hash: file.read().hash });
    expect(forAdmin.servers.map(server => [server.name, server.status])).toEqual([["tui", "unavailable"], ["docs", "available"]]);
    expect(forAdmin.servers[0]).toMatchObject({ reason: expect.stringMatching(/auth\.provider/), otherFields: ["auth"] });
    expect(forAdmin.servers[1]!.config?.headers).toEqual({ "X-Key": SHARED_MCP_MASK });
  });
});
