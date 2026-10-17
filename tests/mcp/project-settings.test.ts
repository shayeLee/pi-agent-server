import { describe, expect, it } from "vitest";
import { parseMcpCatalog } from "../../src/mcp/catalog.js";
import {
  effectiveMcpServerEntries, projectMcpServerViews, validateProjectMcpSetting, type ProjectMcpServerSetting,
} from "../../src/mcp/project-settings.js";

const catalog = parseMcpCatalog({
  version: 1,
  servers: {
    docs: { url: "https://docs.example.com/mcp", description: "Docs", maxExposure: "direct", toolExposure: { search: "direct", "delete_*": "hidden" }, defaultEnabled: true },
    repo: { command: "repo-mcp", description: "Repo" },
    admin: { command: "admin-mcp", description: "Admin", adminOnly: true },
  },
});

function setting(serverName: string, extra: Partial<ProjectMcpServerSetting> = {}): ProjectMcpServerSetting {
  return { serverName, enabled: true, exposure: null, hiddenTools: [], updatedAt: 1, updatedBy: "ip:1", ...extra };
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
