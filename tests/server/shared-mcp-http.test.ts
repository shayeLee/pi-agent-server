import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { LiveMcpCatalog } from "../../src/mcp/live-catalog.js";
import { SharedMcpConfigFile } from "../../src/mcp/shared-config.js";
import { SHARED_MCP_MASK } from "../../src/shared/shared-mcp.js";
import { KyselyProjectMcpRepository } from "../../src/storage/kysely-project-mcp-repository.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess, USER_IP_A } from "../helpers/ip-access.js";

const ADMIN_IP = "10.0.0.9";
const VIEWER_IP = "10.0.0.8";

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-shared-mcp-http-"));
  const configPath = path.join(dir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {
    docs: { url: "https://docs.example.com/mcp", headers: { "X-Key": "secret-value" }, description: "Docs", toolExposure: { search: "hidden" } },
  } }, null, 2));
  const catalog = new LiveMcpCatalog({ piConfigPath: configPath, context: { env: {}, oauthEnabled: false } });
  const { projects, sessions, kysely } = await makeInitializedMemoryDb({ cwd: dir });
  const app = buildApp({
    sessions, projects, defaultProjectCwd: dir, createAdapter: async () => new MockAgentAdapter(),
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: ADMIN_IP, role: "admin" }, { ip: VIEWER_IP, role: "viewer" }]) }),
    projectMcp: { catalog, store: new KyselyProjectMcpRepository(kysely) },
    sharedMcp: { file: new SharedMcpConfigFile(configPath), catalog },
  });
  const list = (remoteAddress: string) => app.inject({ method: "GET", url: "/v1/mcp/shared", remoteAddress });
  const put = (name: string, body: unknown, remoteAddress = ADMIN_IP) => app.inject({
    method: "PUT", url: `/v1/mcp/shared/${name}`, remoteAddress, headers: { "content-type": "application/json" }, payload: JSON.stringify(body),
  });
  const remove = (name: string, hash: string, remoteAddress = ADMIN_IP) =>
    app.inject({ method: "DELETE", url: `/v1/mcp/shared/${name}?hash=${encodeURIComponent(hash)}`, remoteAddress });
  const hash = async () => (await list(ADMIN_IP)).json().file.hash as string;
  const file = () => JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  return { app, dir, configPath, list, put, remove, hash, file };
}

describe("shared MCP routes", () => {
  it("shows everyone the list and only admins the connection details", async () => {
    const { app, list } = await setup();
    try {
      const viewer = (await list(VIEWER_IP)).json();
      expect(viewer).toEqual({ canEdit: false, servers: [{ name: "docs", status: "available", transport: "http", exposure: "codemode", adminOnly: false, description: "Docs" }] });
      const admin = await list(ADMIN_IP);
      expect(admin.headers["cache-control"]).toBe("private, no-store");
      expect(admin.json()).toMatchObject({ canEdit: true, file: { hash: expect.any(String) } });
      expect(admin.json().servers[0]).toMatchObject({ config: { headers: { "X-Key": SHARED_MCP_MASK } }, otherFields: ["toolExposure"] });
      expect(admin.body).not.toContain("secret-value");
    } finally { await app.close(); }
  });

  it("lets only admins add, change and remove servers", async () => {
    const { app, list, put, remove, hash, file } = await setup();
    try {
      const server = { transport: "stdio", command: "npx", args: ["-y", "notes-mcp"], env: { TOKEN: "${NOTES_TOKEN}" } };
      expect((await put("notes", { hash: await hash(), server }, USER_IP_A)).statusCode).toBe(403);
      const added = await put("notes", { hash: await hash(), server });
      expect(added.statusCode).toBe(200);
      expect(file().mcpServers.notes).toEqual({ command: "npx", args: ["-y", "notes-mcp"], env: { TOKEN: "${NOTES_TOKEN}" } });
      // 环境变量没设置：照样写进文件，列表里标为不可用并说明原因。
      expect(added.json().servers[1]).toMatchObject({ name: "notes", status: "unavailable", reason: expect.stringMatching(/NOTES_TOKEN/) });
      expect((await list(USER_IP_A)).json().servers.map((item: { name: string }) => item.name)).toEqual(["docs"]);

      // 打码的值传回去表示不改；表单管不到的 toolExposure 保留。
      const changed = await put("docs", { hash: await hash(), server: { transport: "http", url: "https://docs.example.com/mcp", headers: { "X-Key": SHARED_MCP_MASK }, description: "Docs v2", adminOnly: true } });
      expect(changed.statusCode).toBe(200);
      expect(file().mcpServers.docs).toEqual({
        url: "https://docs.example.com/mcp", headers: { "X-Key": "secret-value" }, description: "Docs v2", toolExposure: { search: "hidden" }, piAgentServer: { adminOnly: true },
      });

      expect((await remove("notes", await hash(), USER_IP_A)).statusCode).toBe(403);
      expect((await remove("notes", await hash())).statusCode).toBe(200);
      expect(Object.keys(file().mcpServers)).toEqual(["docs"]);
      expect((await remove("notes", await hash())).json()).toMatchObject({ code: "mcp_unknown_server" });
    } finally { await app.close(); }
  });

  it("refuses to overwrite a file changed elsewhere and rejects settings it cannot use", async () => {
    const { app, configPath, put, hash, file } = await setup();
    try {
      const stale = await hash();
      writeFileSync(configPath, JSON.stringify({ mcpServers: { ...file().mcpServers, tui: { command: "srv" } } }));
      const conflict = await put("notes", { hash: stale, server: { transport: "stdio", command: "srv" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "mcp_config_changed" });
      const invalid = await put("notes", { hash: await hash(), server: { transport: "http", url: "https://a.example.com", exposure: "direct", maxExposure: "codemode" } });
      expect(invalid.json()).toMatchObject({ statusCode: 400, code: "mcp_config_invalid", message: expect.stringMatching(/超过/) });
      expect((await put("bad name", { hash: await hash(), server: { transport: "stdio", command: "srv" } })).statusCode).toBe(400);
      expect(Object.keys(file().mcpServers)).toEqual(["docs", "tui"]);
    } finally { await app.close(); }
  });

  it("stops a project setting from applying once the server behind the name changes", async () => {
    const { app, dir, put, hash } = await setup();
    try {
      const project = (await app.inject({ method: "POST", url: "/v1/projects", remoteAddress: USER_IP_A, headers: { "content-type": "application/json" },
        payload: JSON.stringify({ name: "p", cwd: dir }) })).json().id as string;
      const settings = async () => (await app.inject({ method: "GET", url: `/v1/projects/${project}/mcp`, remoteAddress: USER_IP_A })).json().servers[0];
      await app.inject({ method: "PUT", url: `/v1/projects/${project}/mcp/servers/docs`, remoteAddress: USER_IP_A,
        headers: { "content-type": "application/json" }, payload: JSON.stringify({ enabled: true }) });
      expect(await settings()).toMatchObject({ name: "docs", enabled: true });
      // 只改说明：还是同一个 server。
      await put("docs", { hash: await hash(), server: { transport: "http", url: "https://docs.example.com/mcp", headers: { "X-Key": SHARED_MCP_MASK }, description: "new" } });
      expect(await settings()).not.toHaveProperty("changed");
      await put("docs", { hash: await hash(), server: { transport: "http", url: "https://elsewhere.example.com/mcp" } });
      expect(await settings()).toMatchObject({ name: "docs", enabled: false, changed: true });
    } finally { await app.close(); }
  });
});
