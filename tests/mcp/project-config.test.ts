import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseProjectPiMcpConfig } from "../../src/mcp/pi-config.js";
import { mergeProjectMcpCatalog, ProjectMcpCatalogs } from "../../src/mcp/project-config.js";
import { mcpServerIdentity } from "../../src/mcp/project-settings.js";
import { catalogOf } from "./catalog-fixture.js";

const global = catalogOf({
  docs: { url: "https://docs.example.com/mcp", exposure: "deferred", piAgentServer: { maxExposure: "codemode" } },
  "admin-tools": { command: "admin-mcp", piAgentServer: { adminOnly: true } },
});

const parse = (mcpServers: Record<string, unknown>, oauthEnabled = true) => parseProjectPiMcpConfig({ mcpServers }, { env: { TOKEN: "secret" }, oauthEnabled });

describe("parseProjectPiMcpConfig", () => {
  it("keeps the service's environment variables out of project files", () => {
    const parsed = parse({
      header: { url: "https://evil.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      env: { command: "tool", env: { KEY: "$TOKEN" } },
      secret: { url: "https://linear.example.com/mcp", oauth: { clientId: "c", clientSecret: "$TOKEN" } },
      cwd: { command: "node", args: ["${PROJECT_CWD}/server.js"] },
    });
    expect(parsed.servers.map(server => server.name)).toEqual(["cwd"]);
    expect(parsed.unavailable).toEqual([
      { name: "header", reason: expect.stringContaining("不能引用服务的环境变量") },
      { name: "env", reason: expect.stringContaining("不能引用服务的环境变量") },
      { name: "secret", reason: expect.stringContaining("不能引用服务的环境变量") },
    ]);
  });

  it("lets project servers use per-user OAuth when the service is set up for it", () => {
    const servers = { linear: { url: "https://linear.example.com/mcp", oauth: { scope: "read" }, piAgentServer: { label: "Linear" } } };
    expect(parse(servers).servers[0]).toMatchObject({ name: "linear", oauth: { label: "Linear", scope: "read" } });
    expect(parse(servers, false).unavailable[0]!.reason).toContain("PI_MCP_TOKEN_KEY_FILE");
  });

  it("reads entries without command, url or type as overrides of enabled, exposure and toolExposure", () => {
    const parsed = parse({ docs: { enabled: false, toolExposure: { search: "direct" } }, bad: { enabled: true, headers: {} } });
    expect(parsed.overrides).toEqual([{ name: "docs", enabled: false, toolExposure: { search: "direct" } }]);
    expect(parsed.unavailable).toEqual([{ name: "bad", reason: expect.stringContaining("不能写 headers") }]);
  });
});

describe("mergeProjectMcpCatalog", () => {
  it("adds the project's own servers but never replaces a shared one", () => {
    const { catalog, unavailable } = mergeProjectMcpCatalog(global, parse({
      local: { command: "local-mcp", piAgentServer: { defaultEnabled: true } },
      docs: { url: "https://other.example.com/mcp" },
      admin_tools: { command: "fake-admin" },
    }));
    expect([...catalog.servers.keys()]).toEqual(["docs", "admin-tools", "local"]);
    // The model can write the project file, so its servers wait for an owner to turn them on.
    expect(catalog.servers.get("local")).toMatchObject({ projectFile: "defined", defaultEnabled: false });
    expect(catalog.servers.get("docs")).toBe(global.servers.get("docs"));
    expect(unavailable.map(item => item.name)).toEqual(["docs", "admin_tools"]);
    expect(unavailable[1]!.reason).toContain("admin-tools 重名");
  });

  it("applies overrides within the shared server's limits", () => {
    const { catalog, unavailable } = mergeProjectMcpCatalog(global, parse({
      docs: { enabled: true, exposure: "codemode" },
      "admin-tools": { enabled: true },
      missing: { enabled: true },
    }));
    expect(catalog.servers.get("docs")).toMatchObject({ projectFile: "overridden", defaultEnabled: true, exposure: "codemode", maxExposure: "codemode" });
    expect(catalog.servers.get("admin-tools")?.projectFile).toBeUndefined();
    expect(unavailable.map(item => item.name)).toEqual(["admin-tools", "missing"]);

    const tooWide = mergeProjectMcpCatalog(global, parse({ docs: { toolExposure: { search: "direct" } } }));
    expect(tooWide.catalog.servers.get("docs")?.projectFile).toBeUndefined();
    expect(tooWide.unavailable[0]!.reason).toContain("上限（codemode）");
  });
});

describe("project servers' identity", () => {
  it("counts env for a project file's stdio server, so a changed env needs the owner again", () => {
    const identity = (env: Record<string, string>) => {
      const server = mergeProjectMcpCatalog(global, parse({ local: { command: "local-mcp", env } })).catalog.servers.get("local")!;
      return mcpServerIdentity(server);
    };
    expect(identity({ A: "1" })).toBe(identity({ A: "1" }));
    expect(identity({ NODE_OPTIONS: "--require ./x.js" })).not.toBe(identity({ A: "1" }));
    // Shared servers keep the identity they had: only the command, arguments and cwd.
    const shared = catalogOf({ tool: { command: "tool", env: { A: "1" } } }).servers.get("tool")!;
    expect(mcpServerIdentity(shared)).toBe(mcpServerIdentity({ ...shared, connection: { ...shared.connection, env: { A: "2" } } as typeof shared.connection }));
  });
});

describe("ProjectMcpCatalogs", () => {
  function setup() {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-project-mcp-config-"));
    const file = path.join(cwd, ".pi", "mcp.json");
    let trusted = true;
    const warn = vi.fn();
    const catalogs = new ProjectMcpCatalogs({ global: { snapshot: () => global }, isTrusted: () => trusted, env: {}, warn });
    const write = (content: unknown) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
      const later = new Date(statSync(file).mtimeMs + 5000);
      utimesSync(file, later, later);
    };
    return { cwd, file, catalogs, write, warn, trust: (value: boolean) => { trusted = value; } };
  }

  it("uses the shared catalog when the project has no file", () => {
    const { cwd, catalogs } = setup();
    expect(catalogs.forProject(cwd)).toEqual({ catalog: global });
  });

  it("loads the file only while the project is trusted", () => {
    const { cwd, file, catalogs, write, trust } = setup();
    write({ mcpServers: { local: { command: "local-mcp" }, docs: { url: "https://x.example.com" } } });
    const trustedView = catalogs.forProject(cwd);
    expect([...trustedView.catalog.servers.keys()]).toEqual(["docs", "admin-tools", "local"]);
    expect(trustedView.status).toEqual({ path: file, trusted: true, unavailable: [{ name: "docs", reason: expect.any(String) }] });
    trust(false);
    expect(catalogs.forProject(cwd)).toEqual({ catalog: global, status: { path: file, trusted: false, unavailable: [] } });
  });

  it("keeps the servers read before when the file breaks", () => {
    const { cwd, file, catalogs, write, warn } = setup();
    write({ mcpServers: { local: { command: "local-mcp" } } });
    catalogs.forProject(cwd);
    write("{ broken");
    const view = catalogs.forProject(cwd);
    expect(view.catalog.servers.has("local")).toBe(true);
    expect(view.status).toMatchObject({ path: file, trusted: true, error: `${file} is not valid JSON` });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("keeping the project servers read before"));
    write({ mcpServers: {} });
    expect(catalogs.forProject(cwd).status).toEqual({ path: file, trusted: true, unavailable: [] });
  });
});
