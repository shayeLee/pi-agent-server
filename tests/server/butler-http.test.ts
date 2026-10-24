import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { KyselyButlerRepository } from "../../src/storage/kysely-butler-repository.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";

const ADMIN = "10.0.0.1";
const USER = "10.0.0.2";
const VIEWER = "10.0.0.3";

async function makeApp(withButlers = true) {
  const { projects, sessions, kysely } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const ipAccess = makeTestIpAccess({ policy: makePolicy([{ ip: ADMIN, role: "admin" }, { ip: USER, role: "user" }, { ip: VIEWER, role: "viewer" }]) });
  return buildApp({ sessions, projects, defaultProjectCwd: "/tmp/default-project", ipAccess,
    ...(withButlers ? { butlers: new KyselyButlerRepository(kysely) } : {}),
    createAdapter: async () => new MockAgentAdapter() });
}

describe("/v1/butler", () => {
  it("admins get one butler, a reset replaces it, and it never shows in the lists", async () => {
    const app = await makeApp();
    const call = (method: "GET" | "POST", payload?: Record<string, unknown>) => app.inject({ method, url: "/v1/butler", remoteAddress: ADMIN, ...(payload !== undefined ? { payload } : {}) });
    expect((await call("GET")).json()).toEqual({ session: null });
    const created = (await call("POST")).json().session;
    expect(created).toMatchObject({ projectId: expect.any(String), title: "" });
    expect(created).not.toHaveProperty("kind");
    expect(created.systemPrompt).toContain("「小派」");
    expect((await call("POST", {})).json().session.id).toBe(created.id);
    const reset = (await call("POST", { reset: true })).json().session;
    expect(reset.id).not.toBe(created.id);
    expect((await call("GET")).json().session.id).toBe(reset.id);
    expect((await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: ADMIN })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: ADMIN })).json()).toEqual([]);
    expect((await call("POST", { reset: "yes" })).statusCode).toBe(400);
  });

  it("other roles are refused, and a host without butlers answers 404", async () => {
    const app = await makeApp();
    for (const ip of [USER, VIEWER]) {
      const reply = await app.inject({ method: "GET", url: "/v1/butler", remoteAddress: ip });
      expect(reply.statusCode).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/v1/butler", remoteAddress: USER })).json()).toMatchObject({ code: "butler_admin_only" });
    const bare = await makeApp(false);
    expect((await bare.inject({ method: "GET", url: "/v1/butler", remoteAddress: ADMIN })).statusCode).toBe(404);
  });
});
