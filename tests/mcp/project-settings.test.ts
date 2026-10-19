import { describe, expect, it } from "vitest";
import { catalogOf } from "./catalog-fixture.js";
import {
  effectiveMcpServerEntries, mcpServerIdentity, projectMcpServerViews, validateProjectMcpSetting, type ProjectMcpServerSetting,
} from "../../src/mcp/project-settings.js";

const catalog = catalogOf({
  docs: { url: "https://docs.example.com/mcp", description: "Docs", toolExposure: { search: "direct", "delete_*": "hidden" }, piAgentServer: { maxExposure: "direct", defaultEnabled: true } },
  repo: { command: "repo-mcp", description: "Repo" },
  admin: { command: "admin-mcp", description: "Admin", piAgentServer: { adminOnly: true } },
});

function setting(serverName: string, extra: Partial<ProjectMcpServerSetting> = {}): ProjectMcpServerSetting {
  return { serverName, enabled: true, exposure: null, hiddenTools: [], updatedAt: 1, updatedBy: "ip:1", serverIdentity: null, ...extra };
}

describe("effectiveMcpServerEntries", () => {
  it("uses catalog defaults without project settings", () => {
    const entries = effectiveMcpServerEntries(catalog, []);
    expect(entries.map(entry => entry.name)).toEqual(["docs"]);
    expect(entries[0]!.config).toMatchObject({ url: "https://docs.example.com/mcp", description: "Docs", exposure: "codemode", toolExposure: { search: "direct", "delete_*": "hidden" } });
  });

  it("enables, disables and tightens per project", () => {
    const entries = effectiveMcpServerEntries(catalog, [
      setting("docs", { exposure: "deferred", hiddenTools: ["search", "write"] }),
      setting("repo"),
      setting("gone"),
    ]);
    expect(entries.map(entry => entry.name)).toEqual(["docs", "repo"]);
    expect(entries[0]!.config).toMatchObject({ exposure: "deferred", toolExposure: { search: "hidden", "delete_*": "hidden", write: "hidden" } });
    expect(effectiveMcpServerEntries(catalog, [setting("docs", { enabled: false })])).toEqual([]);
  });

  it("caps catalog tool overrides at the project's server exposure", () => {
    const [docs] = effectiveMcpServerEntries(catalog, [setting("docs", { exposure: "codemode" })]);
    expect(docs!.config).toMatchObject({ exposure: "codemode", toolExposure: { search: "codemode" } });
    const [hidden] = effectiveMcpServerEntries(catalog, [setting("docs", { exposure: "hidden" })]);
    expect(hidden!.config).toMatchObject({ exposure: "hidden", toolExposure: { search: "hidden" } });
  });
});

describe("validateProjectMcpSetting", () => {
  it("only allows catalog servers within maxExposure", () => {
    expect(validateProjectMcpSetting(catalog, "nope", { enabled: true }, true)).toEqual({ code: "unknown_server" });
    expect(validateProjectMcpSetting(catalog, "repo", { enabled: true, exposure: "direct" }, true)).toMatchObject({ code: "invalid" });
    expect(validateProjectMcpSetting(catalog, "repo", { enabled: true, exposure: "deferred" }, false)).toBeNull();
    expect(validateProjectMcpSetting(catalog, "repo", { enabled: true, hiddenTools: ["a*"] }, false)).toMatchObject({ code: "invalid" });
  });

  it("lets only admins enable adminOnly servers, while anyone may disable them", () => {
    expect(validateProjectMcpSetting(catalog, "admin", { enabled: true }, false)).toEqual({ code: "admin_only" });
    expect(validateProjectMcpSetting(catalog, "admin", { enabled: true }, true)).toBeNull();
    expect(validateProjectMcpSetting(catalog, "admin", { enabled: false }, false)).toBeNull();
  });
});

describe("projectMcpServerViews", () => {
  it("lists catalog servers and marks settings for removed servers missing", () => {
    const views = projectMcpServerViews(catalog, [setting("repo", { updatedAt: 5 }), setting("gone")]);
    expect(views.map(view => [view.name, view.status, view.enabled])).toEqual([
      ["docs", "available", true], ["repo", "available", true], ["admin", "available", false], ["gone", "missing", false],
    ]);
    expect(views[1]).toMatchObject({ transport: "stdio", exposure: "codemode", maxExposure: "codemode", updatedAt: 5 });
    expect(views[0]).toMatchObject({ updatedAt: null });
  });
});

describe("mcpServerIdentity", () => {
  const identityOf = (config: Record<string, unknown>) => mcpServerIdentity(catalogOf({ s: config }).servers.get("s")!);

  it("changes with the address or command, not with credentials or descriptions", () => {
    const url = identityOf({ url: "https://docs.example.com/mcp" });
    expect(identityOf({ url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer x" }, description: "new" })).toBe(url);
    expect(identityOf({ url: "https://other.example.com/mcp" })).not.toBe(url);
    const command = identityOf({ command: "srv", args: ["a"] });
    expect(identityOf({ command: "srv", args: ["a"], env: { TOKEN: "t" } })).toBe(command);
    expect(identityOf({ command: "srv", args: ["b"] })).not.toBe(command);
    expect(identityOf({ command: "srv", args: ["a"], cwd: "/tmp" })).not.toBe(command);
  });

  it("stops applying a project setting made for another server under the same name", () => {
    const docs = catalog.servers.get("docs")!;
    const old = setting("docs", { serverIdentity: "made-for-another-server" });
    // docs 默认启用；设置过期后连默认值也不算，要 owner 重新确认。
    expect(effectiveMcpServerEntries(catalog, [old])).toEqual([]);
    expect(projectMcpServerViews(catalog, [old])[0]).toMatchObject({ name: "docs", enabled: false, changed: true });
    const confirmed = setting("docs", { serverIdentity: mcpServerIdentity(docs) });
    expect(effectiveMcpServerEntries(catalog, [confirmed]).map(entry => entry.name)).toEqual(["docs"]);
    expect(projectMcpServerViews(catalog, [confirmed])[0]).not.toHaveProperty("changed");
  });
});
