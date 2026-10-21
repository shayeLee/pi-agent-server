import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { McpOAuthConnections } from "../../src/mcp/oauth-connections.js";
import type { McpCatalog } from "../../src/mcp/catalog.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { KyselyProjectMcpRepository } from "../../src/storage/kysely-project-mcp-repository.js";
import { makePolicy, makeTestIpAccess, USER_IP_A, USER_IP_B } from "../helpers/ip-access.js";

const VIEWER_IP = "10.0.0.8";
type McpOAuthDeps = Pick<McpOAuthConnections, "list" | "start" | "complete" | "disconnect" | "returnUrl">;

function fakeMcpOAuth(): McpOAuthDeps & { [K in "list" | "start" | "complete" | "disconnect"]: ReturnType<typeof vi.fn> } {
  return {
    returnUrl: "https://pi.example.test/",
    list: vi.fn(async () => [{ name: "linear", label: "Linear", connected: false }]),
    start: vi.fn(async (_owner: string, name: string) => name === "linear"
      ? { authorizationUrl: "https://auth.example.test/authorize?state=s" }
      : name === "insecure" ? { code: "registration_rejected" as const, message: "Linear 只接受 HTTPS 回调地址" } : { code: "unknown_server" as const, message: "no" }),
    complete: vi.fn(async (owner: string) => owner === `ip:${USER_IP_A}` ? { ok: true as const, server: "linear" } : { ok: false as const, reason: "expired" as const }),
    disconnect: vi.fn(async (_owner: string, name: string) => name === "linear"),
  };
}

async function setup(options: { mcpOAuth?: McpOAuthDeps; tokenRequired?: boolean; forProject?: (cwd: string) => { catalog: McpCatalog } } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-mcp-oauth-http-"));
  const { projects, sessions, kysely } = await makeInitializedMemoryDb({ cwd: dir });
  const policy = makePolicy([
    { ip: VIEWER_IP, role: "viewer" },
    ...(options.tokenRequired ? [{ ip: USER_IP_B, tokenRequired: true, tokens: ["valid-token"] }] : []),
  ]);
  return buildApp({
    sessions, projects, defaultProjectCwd: dir, createAdapter: async () => new MockAgentAdapter(),
    ipAccess: makeTestIpAccess({ policy }),
    ...(options.mcpOAuth ? { mcpOAuth: options.mcpOAuth } : {}),
    ...(options.forProject ? { projectMcp: { catalog: { servers: new Map() }, projectCatalogs: { forProject: options.forProject }, store: new KyselyProjectMcpRepository(kysely) } } : {}),
  });
}

describe("MCP OAuth routes", () => {
  it("passes the caller's project, with its own catalog, and hides other owners' projects", async () => {
    const mcpOAuth = fakeMcpOAuth();
    const catalog: McpCatalog = { servers: new Map() };
    const forProject = vi.fn((_cwd: string) => ({ catalog }));
    const app = await setup({ mcpOAuth, forProject });
    try {
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-mcp-oauth-project-")));
      const projectId = (await app.inject({ method: "POST", url: "/v1/projects", remoteAddress: USER_IP_A,
        headers: { "content-type": "application/json" }, payload: JSON.stringify({ name: "p", cwd }) })).json().id as string;
      await app.inject({ method: "GET", url: `/v1/mcp/connections?projectId=${projectId}`, remoteAddress: USER_IP_A });
      expect(mcpOAuth.list).toHaveBeenLastCalledWith(`ip:${USER_IP_A}`, { id: projectId, catalog });
      expect(forProject).toHaveBeenLastCalledWith(cwd);
      await app.inject({ method: "POST", url: `/v1/mcp/servers/linear/oauth/start?projectId=${projectId}`, remoteAddress: USER_IP_A });
      expect(mcpOAuth.start).toHaveBeenLastCalledWith(`ip:${USER_IP_A}`, "linear", { id: projectId, catalog });
      await app.inject({ method: "DELETE", url: `/v1/mcp/servers/linear/connection?projectId=${projectId}`, remoteAddress: USER_IP_A });
      expect(mcpOAuth.disconnect).toHaveBeenLastCalledWith(`ip:${USER_IP_A}`, "linear", { id: projectId, catalog });
      for (const [method, url] of [["GET", "/v1/mcp/connections"], ["POST", "/v1/mcp/servers/linear/oauth/start"], ["DELETE", "/v1/mcp/servers/linear/connection"]] as const) {
        expect((await app.inject({ method, url: `${url}?projectId=${projectId}`, remoteAddress: USER_IP_B })).statusCode).toBe(404);
      }
    } finally { await app.close(); }
  });

  it("lists, starts, completes and disconnects for the calling IP", async () => {
    const mcpOAuth = fakeMcpOAuth();
    const app = await setup({ mcpOAuth });
    try {
      const listed = await app.inject({ method: "GET", url: "/v1/mcp/connections", remoteAddress: USER_IP_A });
      expect(listed.json()).toEqual({ servers: [{ name: "linear", label: "Linear", connected: false }] });
      expect(listed.headers["cache-control"]).toBe("private, no-store");

      const started = await app.inject({ method: "POST", url: "/v1/mcp/servers/linear/oauth/start", remoteAddress: USER_IP_A });
      expect(started.json()).toEqual({ authorizationUrl: "https://auth.example.test/authorize?state=s" });
      expect(mcpOAuth.start).toHaveBeenCalledWith(`ip:${USER_IP_A}`, "linear", undefined);

      const back = await app.inject({ method: "GET", url: "/v1/mcp/oauth/callback?code=c&state=s&iss=https%3A%2F%2Fauth.example.test&extra=1", remoteAddress: USER_IP_A });
      expect(back.statusCode).toBe(302);
      expect(back.headers.location).toBe("https://pi.example.test/?mcp_oauth=connected&mcp_server=linear");
      expect(mcpOAuth.complete).toHaveBeenCalledWith(`ip:${USER_IP_A}`, { code: "c", state: "s", iss: "https://auth.example.test" });

      const other = await app.inject({ method: "GET", url: "/v1/mcp/oauth/callback?code=c&state=s", remoteAddress: USER_IP_B });
      expect(other.headers.location).toBe("https://pi.example.test/?mcp_oauth=expired");

      expect((await app.inject({ method: "DELETE", url: "/v1/mcp/servers/linear/connection", remoteAddress: USER_IP_A })).statusCode).toBe(204);
      expect((await app.inject({ method: "DELETE", url: "/v1/mcp/servers/other/connection", remoteAddress: USER_IP_A })).json()).toMatchObject({ code: "mcp_not_connected" });
    } finally { await app.close(); }
  });

  it("maps start failures to readable errors", async () => {
    const app = await setup({ mcpOAuth: fakeMcpOAuth() });
    try {
      const insecure = await app.inject({ method: "POST", url: "/v1/mcp/servers/insecure/oauth/start", remoteAddress: USER_IP_A });
      expect(insecure.statusCode).toBe(502);
      expect(insecure.json()).toMatchObject({ code: "mcp_oauth_registration_rejected", message: "Linear 只接受 HTTPS 回调地址" });
      expect((await app.inject({ method: "POST", url: "/v1/mcp/servers/nope/oauth/start", remoteAddress: USER_IP_A })).json()).toMatchObject({ code: "mcp_unknown_server" });
    } finally { await app.close(); }
  });

  it("keeps viewers out and answers plainly without oauth servers", async () => {
    const app = await setup();
    try {
      expect((await app.inject({ method: "GET", url: "/v1/mcp/connections", remoteAddress: VIEWER_IP })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/v1/mcp/servers/linear/oauth/start", remoteAddress: VIEWER_IP })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/v1/mcp/connections", remoteAddress: USER_IP_A })).json()).toEqual({ servers: [] });
      expect((await app.inject({ method: "POST", url: "/v1/mcp/servers/linear/oauth/start", remoteAddress: USER_IP_A })).json()).toMatchObject({ code: "mcp_oauth_not_configured" });
    } finally { await app.close(); }
  });

  it("does not ask for a Bearer token on the callback alone", async () => {
    const mcpOAuth = fakeMcpOAuth();
    const app = await setup({ mcpOAuth, tokenRequired: true });
    try {
      expect((await app.inject({ method: "POST", url: "/v1/mcp/servers/linear/oauth/start", remoteAddress: USER_IP_B })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/v1/mcp/servers/linear/oauth/start", remoteAddress: USER_IP_B, headers: { authorization: "Bearer valid-token" } })).statusCode).toBe(200);
      const back = await app.inject({ method: "GET", url: "/v1/mcp/oauth/callback?code=c&state=s", remoteAddress: USER_IP_B });
      expect(back.statusCode).toBe(302);
      expect((await app.inject({ method: "GET", url: "/v1/mcp/oauth/callback/x", remoteAddress: USER_IP_B })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
