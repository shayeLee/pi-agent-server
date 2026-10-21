import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialInfo, Provider } from "@earendil-works/pi-ai";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { ProviderLogins, type ProviderLoginRuntime } from "../../src/model-adapters/pi-provider-logins.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess, USER_IP_A } from "../helpers/ip-access.js";

const ADMIN_IP = "10.0.0.9";
const OTHER_ADMIN_IP = "10.0.0.10";

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-provider-auth-http-"));
  const stored: CredentialInfo[] = [{ providerId: "openai", type: "oauth" }];
  const saved: string[] = [];
  const runtime: ProviderLoginRuntime = {
    getProviders: () => [{ id: "openai", name: "OpenAI", auth: { apiKey: { name: "OpenAI API key", login: async () => ({}) } } } as unknown as Provider],
    getProviderAuthStatus: () => ({ configured: true }),
    isUsingOAuth: () => false,
    listCredentials: async () => stored,
    login: async (_provider, _type, interaction) => { saved.push(await interaction.prompt({ type: "secret", message: "API key" })); },
    logout: async providerId => { stored.splice(stored.findIndex(item => item.providerId === providerId), 1); },
  };
  const { projects, sessions } = await makeInitializedMemoryDb({ cwd: dir });
  const app = buildApp({
    sessions, projects, defaultProjectCwd: dir, createAdapter: async () => new MockAgentAdapter(),
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: ADMIN_IP, role: "admin" }, { ip: OTHER_ADMIN_IP, role: "admin" }]) }),
    providerLogins: new ProviderLogins(runtime),
  });
  const send = (method: "GET" | "POST" | "DELETE", url: string, body?: unknown, remoteAddress = ADMIN_IP) => app.inject({
    method, url, remoteAddress,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, payload: JSON.stringify(body) }),
  });
  return { app, send, saved, stored };
}

describe("provider auth routes", () => {
  it("lets only admins see providers and sign in, answering prompts until done", async () => {
    const { app, send, saved } = await setup();
    try {
      expect((await send("GET", "/v1/provider-auth", undefined, USER_IP_A)).statusCode).toBe(403);
      expect((await send("POST", "/v1/provider-auth/logins", { provider: "openai", method: "api_key" }, USER_IP_A)).statusCode).toBe(403);
      const list = await send("GET", "/v1/provider-auth");
      expect(list.headers["cache-control"]).toBe("private, no-store");
      expect(list.json().providers[0]).toMatchObject({ id: "openai", stored: "oauth", apiKey: { interactive: true } });

      const started = await send("POST", "/v1/provider-auth/logins", { provider: "openai", method: "api_key" });
      expect(started.statusCode).toBe(201);
      const id = started.json().id as string;
      const login = (await send("GET", `/v1/provider-auth/logins/${id}`)).json();
      expect(login.prompt).toMatchObject({ type: "secret", message: "API key" });
      // 另一位 admin 看不到别人发起的登录。
      expect((await send("GET", `/v1/provider-auth/logins/${id}`, undefined, OTHER_ADMIN_IP)).json()).toMatchObject({ code: "provider_auth_unknown_login" });

      const answered = await send("POST", `/v1/provider-auth/logins/${id}/answer`, { promptId: login.prompt.id, value: "sk-test-value" });
      expect(answered.statusCode).toBe(200);
      expect(answered.body).not.toContain("sk-test-value");
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await send("GET", `/v1/provider-auth/logins/${id}`)).json()).toMatchObject({ state: "succeeded" });
      expect(saved).toEqual(["sk-test-value"]);
      expect((await send("POST", `/v1/provider-auth/logins/${id}/answer`, { promptId: login.prompt.id, value: "again" })).json())
        .toMatchObject({ code: "provider_auth_stale_prompt" });
    } finally { await app.close(); }
  });

  it("rejects unknown providers and methods, and cancels a login", async () => {
    const { app, send } = await setup();
    try {
      expect((await send("POST", "/v1/provider-auth/logins", { provider: "nope", method: "oauth" })).json()).toMatchObject({ code: "provider_auth_unknown_provider" });
      expect((await send("POST", "/v1/provider-auth/logins", { provider: "openai", method: "oauth" })).json()).toMatchObject({ code: "provider_auth_unsupported_method" });
      expect((await send("POST", "/v1/provider-auth/logins", { provider: "openai", method: "password" })).statusCode).toBe(400);
      const { id } = (await send("POST", "/v1/provider-auth/logins", { provider: "openai", method: "api_key" })).json();
      expect((await send("DELETE", `/v1/provider-auth/logins/${id}`)).json()).toMatchObject({ state: "cancelled" });
    } finally { await app.close(); }
  });

  it("removes stored credentials only", async () => {
    const { app, send, stored } = await setup();
    try {
      expect((await send("DELETE", "/v1/provider-auth/credentials/openai", undefined, USER_IP_A)).statusCode).toBe(403);
      const removed = await send("DELETE", "/v1/provider-auth/credentials/openai");
      expect(removed.statusCode).toBe(200);
      expect(stored).toEqual([]);
      expect(removed.json().providers[0].stored).toBeUndefined();
      expect((await send("DELETE", "/v1/provider-auth/credentials/openai")).json()).toMatchObject({ code: "provider_auth_not_stored" });
    } finally { await app.close(); }
  });

  it("says when the server does not offer provider sign-in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-provider-auth-off-"));
    const { projects, sessions } = await makeInitializedMemoryDb({ cwd: dir });
    const app = buildApp({
      sessions, projects, defaultProjectCwd: dir, createAdapter: async () => new MockAgentAdapter(),
      ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: ADMIN_IP, role: "admin" }]) }),
    });
    try {
      expect((await app.inject({ method: "GET", url: "/v1/provider-auth", remoteAddress: ADMIN_IP })).json()).toMatchObject({ code: "provider_auth_not_configured" });
    } finally { await app.close(); }
  });
});
