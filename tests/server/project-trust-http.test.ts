import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { ProjectTrust } from "../../src/settings/project-trust.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess, USER_IP_A, USER_IP_B } from "../helpers/ip-access.js";

const ADMIN_IP = "10.0.0.9";

async function setup(withTrust = true) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-project-trust-http-")));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  writeFileSync(path.join(project, ".pi", "SYSTEM.md"), "prompt");
  const { projects, sessions } = await makeInitializedMemoryDb({ cwd: root });
  const app = buildApp({
    sessions, projects, defaultProjectCwd: root, createAdapter: async () => new MockAgentAdapter(),
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: ADMIN_IP, role: "admin" }]) }),
    ...(withTrust ? { projectTrust: new ProjectTrust(agentDir, { defaultTrust: () => "ask" }) } : {}),
  });
  // 项目只对它的 owner 可见；admin 在 Web 上也只能设置自己看得到的项目。
  const created = await app.inject({ method: "POST", url: "/v1/projects", remoteAddress: ADMIN_IP,
    headers: { "content-type": "application/json" }, payload: JSON.stringify({ name: "p", cwd: project }) });
  const projectId = created.json().id as string;
  const get = (remoteAddress: string) => app.inject({ method: "GET", url: `/v1/projects/${projectId}/trust`, remoteAddress });
  const put = (trusted: unknown, remoteAddress = ADMIN_IP) => app.inject({ method: "PUT", url: `/v1/projects/${projectId}/trust`, remoteAddress,
    headers: { "content-type": "application/json" }, payload: JSON.stringify({ trusted }) });
  return { app, agentDir, project, projectId, get, put };
}

describe("project trust routes", () => {
  it("shows the trust state and lets only admins change it", async () => {
    const { app, agentDir, project, get, put } = await setup();
    try {
      const shown = (await get(ADMIN_IP)).json();
      expect(shown).toMatchObject({ trusted: false, source: "default", defaultTrust: "ask", canEdit: true });
      expect(shown.files.find((file: { name: string }) => file.name === ".pi/SYSTEM.md")).toEqual({ name: ".pi/SYSTEM.md", exists: true });
      expect((await put(true, USER_IP_A)).statusCode).toBe(403);
      expect((await put("yes")).statusCode).toBe(400);
      const saved = await put(true);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ trusted: true, source: "project", canEdit: true });
      expect(JSON.parse(readFileSync(path.join(agentDir, "trust.json"), "utf8"))).toEqual({ [project]: true });
      expect((await get(ADMIN_IP)).json()).toMatchObject({ trusted: true, source: "project" });
    } finally { await app.close(); }
  });

  it("hides other owners' projects, refuses a broken trust.json and says when trust is not configured", async () => {
    const { app, agentDir, get, put } = await setup();
    try {
      expect((await get(USER_IP_B)).statusCode).toBe(404);
      writeFileSync(path.join(agentDir, "trust.json"), "{ broken");
      expect((await put(true)).json()).toMatchObject({ statusCode: 409, code: "trust_unavailable" });
      expect(readFileSync(path.join(agentDir, "trust.json"), "utf8")).toBe("{ broken");
    } finally { await app.close(); }
    const bare = await setup(false);
    try {
      expect((await bare.get(ADMIN_IP)).json()).toMatchObject({ statusCode: 404, code: "trust_not_configured" });
    } finally { await bare.app.close(); }
  });
});
