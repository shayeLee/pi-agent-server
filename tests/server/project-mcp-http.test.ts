import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { DEFAULT_PROJECT_ID } from "../../src/shared/project-identity.js";
import { catalogOf } from "../mcp/catalog-fixture.js";
import { KyselyProjectMcpRepository } from "../../src/storage/kysely-project-mcp-repository.js";
import { ProjectMcpCatalogs } from "../../src/mcp/project-config.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess, USER_IP_A, USER_IP_B } from "../helpers/ip-access.js";

const ADMIN_IP = "10.0.0.9";
const VIEWER_IP = "10.0.0.8";
const catalog = catalogOf({
  docs: { url: "https://docs.example.com/mcp", description: "Docs" },
  admin: { command: "admin-mcp", description: "Admin tools", piAgentServer: { adminOnly: true } },
});

async function setup(withMcp = true, projectCatalogs?: (dir: string) => ProjectMcpCatalogs) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-project-mcp-http-"));
  const { projects, sessions, kysely } = await makeInitializedMemoryDb({ cwd: dir });
  const app = buildApp({
    sessions, projects, defaultProjectCwd: dir, createAdapter: async () => new MockAgentAdapter(),
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: ADMIN_IP, role: "admin" }, { ip: VIEWER_IP, role: "viewer" }]) }),
    ...(withMcp ? { projectMcp: { catalog, store: new KyselyProjectMcpRepository(kysely), ...(projectCatalogs ? { projectCatalogs: projectCatalogs(dir) } : {}) } } : {}),
  });
  const created = await app.inject({ method: "POST", url: "/v1/projects", remoteAddress: USER_IP_A,
    headers: { "content-type": "application/json" }, payload: JSON.stringify({ name: "p", cwd: dir }) });
  const projectId = created.json().id as string;
  const get = (id: string, remoteAddress: string) => app.inject({ method: "GET", url: `/v1/projects/${id}/mcp`, remoteAddress });
  const put = (id: string, server: string, body: unknown, remoteAddress: string) => app.inject({
    method: "PUT", url: `/v1/projects/${id}/mcp/servers/${server}`, remoteAddress,
    headers: { "content-type": "application/json" }, payload: JSON.stringify(body),
  });
  return { app, dir, projectId, get, put };
}

describe("project MCP routes", () => {
  it("lets the owner enable and tighten catalog servers", async () => {
    const { app, projectId, get, put } = await setup();
    try {
      const listed = (await get(projectId, USER_IP_A)).json();
      expect(listed).toMatchObject({ configured: true, canEdit: true });
      expect(listed.servers.map((server: { name: string; enabled: boolean }) => [server.name, server.enabled])).toEqual([["docs", false], ["admin", false]]);
      const saved = await put(projectId, "docs", { enabled: true, exposure: "deferred", hiddenTools: ["write", "write"] }, USER_IP_A);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().server).toMatchObject({ name: "docs", enabled: true, exposure: "deferred", hiddenTools: ["write"] });
      expect((await put(projectId, "docs", { enabled: true, exposure: "direct" }, USER_IP_A)).statusCode).toBe(400);
      expect((await put(projectId, "nope", { enabled: true }, USER_IP_A)).json()).toMatchObject({ code: "mcp_unknown_server" });
    } finally { await app.close(); }
  });

  it("keeps adminOnly servers and the shared default project for admins", async () => {
    const { app, projectId, get, put } = await setup();
    try {
      const canEnable = async (id: string, ip: string) => Object.fromEntries((await get(id, ip)).json().servers.map((server: { name: string; canEnable: boolean }) => [server.name, server.canEnable]));
      expect(await canEnable(projectId, USER_IP_A)).toEqual({ docs: true, admin: false });
      expect(await canEnable(DEFAULT_PROJECT_ID, USER_IP_A)).toEqual({ docs: false, admin: false });
      expect(await canEnable(DEFAULT_PROJECT_ID, ADMIN_IP)).toEqual({ docs: true, admin: true });
      expect((await put(projectId, "admin", { enabled: true }, USER_IP_A)).json()).toMatchObject({ code: "mcp_admin_only" });
      expect((await put(projectId, "admin", { enabled: false }, USER_IP_A)).statusCode).toBe(200);
      expect((await put(DEFAULT_PROJECT_ID, "docs", { enabled: true }, USER_IP_A)).json()).toMatchObject({ code: "mcp_default_project" });
      expect((await put(DEFAULT_PROJECT_ID, "admin", { enabled: true }, ADMIN_IP)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("hides other owners' projects and keeps viewers read-only", async () => {
    const { app, projectId, get, put } = await setup();
    try {
      expect((await get(projectId, USER_IP_B)).statusCode).toBe(404);
      expect((await put(projectId, "docs", { enabled: true }, USER_IP_B)).statusCode).toBe(404);
      expect((await get(DEFAULT_PROJECT_ID, VIEWER_IP)).json()).toMatchObject({ configured: true, canEdit: false });
      expect((await put(DEFAULT_PROJECT_ID, "docs", { enabled: true }, VIEWER_IP)).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it("lists a trusted project's own .pi/mcp.json servers and lets the owner enable them", async () => {
    let trusted = true;
    const { app, dir, projectId, get, put } = await setup(true, () => new ProjectMcpCatalogs({ global: { snapshot: () => catalog }, isTrusted: () => trusted, env: {} }));
    try {
      mkdirSync(path.join(dir, ".pi"));
      // 项目 cwd 按真实路径保存（macOS 的 /var 是 /private/var）。
      const file = path.join(realpathSync(dir), ".pi", "mcp.json");
      writeFileSync(file, JSON.stringify({ mcpServers: { local: { command: "local-mcp" }, docs: { enabled: true }, admin: { url: "https://x.example.com" } } }));
      const listed = (await get(projectId, USER_IP_A)).json();
      expect(listed.servers.map((server: { name: string; enabled: boolean; projectFile?: string }) => [server.name, server.enabled, server.projectFile]))
        .toEqual([["docs", true, "overridden"], ["admin", false, undefined], ["local", false, "defined"]]);
      expect(listed.projectConfig).toEqual({ path: file, trusted: true, unavailable: [{ name: "admin", reason: expect.stringContaining("重名") }] });
      expect((await put(projectId, "local", { enabled: true }, USER_IP_A)).json().server).toMatchObject({ name: "local", enabled: true, projectFile: "defined" });

      trusted = false;
      const untrusted = (await get(projectId, USER_IP_A)).json();
      expect(untrusted.servers.map((server: { name: string; status: string }) => [server.name, server.status])).toEqual([["docs", "available"], ["admin", "available"], ["local", "missing"]]);
      expect(untrusted.projectConfig).toEqual({ path: file, trusted: false, unavailable: [] });
      expect((await put(projectId, "local", { enabled: true }, USER_IP_A)).json()).toMatchObject({ code: "mcp_unknown_server" });
    } finally { await app.close(); }
  });

  it("reports an unconfigured server", async () => {
    const { app, projectId, get, put } = await setup(false);
    try {
      expect((await get(projectId, USER_IP_A)).json()).toEqual({ configured: false, canEdit: false, servers: [] });
      expect((await put(projectId, "docs", { enabled: true }, USER_IP_A)).json()).toMatchObject({ code: "mcp_not_configured" });
    } finally { await app.close(); }
  });
});
