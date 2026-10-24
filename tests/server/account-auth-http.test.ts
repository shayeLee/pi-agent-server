// Accounts mode over real HTTP handling (docs/login-design.md §4–§6, test matrix §13).
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { resolveAuthConfig } from "../../src/auth/auth-config.js";
import { AuthService } from "../../src/auth/auth-service.js";
import { KyselyAccountRepository } from "../../src/storage/kysely-account-repository.js";
import type { AccountStorePort } from "../../src/application/ports/account-store-port.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess, OUTSIDE_IP } from "../helpers/ip-access.js";

const PUBLIC_URL = "http://192.168.5.137:5180";
const PHONE = PUBLIC_URL;
const DEV = "http://127.0.0.1:5173";
const DESKTOP = "http://127.0.0.1:5180";
const COOKIE = "pi_session_5180";
const PASSWORD = "correct horse battery";
const JSON_HEADERS = { "content-type": "application/json" };

type Fixture = {
  app: FastifyInstance;
  auth: AuthService;
  adapters: MockAgentAdapter[];
  /** Makes every account lookup throw, to stand in for an unavailable database. */
  failLookups: { on: boolean };
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => {})));
});

async function makeFixture(options: { recheckMs?: number } = {}): Promise<Fixture> {
  const storage = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const failLookups = { on: false };
  const repository = new KyselyAccountRepository(storage.kysely, "sqlite");
  const store = new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (failLookups.on && typeof property === "string" && property.startsWith("find")) return Promise.reject(new Error("db down"));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as AccountStorePort;
  const auth = new AuthService(store);
  const adapters: MockAgentAdapter[] = [];
  const app = buildApp({
    sessions: storage.sessions,
    projects: storage.projects,
    defaultProjectCwd: "/tmp/default-project",
    ipAccess: makeTestIpAccess(),
    authConfig: resolveAuthConfig({ mode: "accounts", publicUrl: PUBLIC_URL, trustedOrigins: [PHONE, DESKTOP, DEV].join(",") }),
    accountAuth: auth,
    authRecheckIntervalMs: options.recheckMs ?? 30_000,
    authRecheckTimeoutMs: 200,
    createAdapter: async () => {
      const adapter = new MockAgentAdapter();
      adapters.push(adapter);
      return adapter;
    },
  });
  apps.push(app);
  return { app, auth, adapters, failLookups };
}

function cookieOf(res: LightMyRequestResponse): string {
  const header = res.headers["set-cookie"];
  const value = String(Array.isArray(header) ? header[0] : header);
  return value.split(";")[0]!;
}

async function login(app: FastifyInstance, name: string, password = PASSWORD, extra: { origin?: string; remoteAddress?: string } = {}) {
  return app.inject({
    method: "POST", url: "/v1/auth/login", remoteAddress: extra.remoteAddress ?? "10.0.0.1",
    headers: { ...JSON_HEADERS, origin: extra.origin ?? PHONE },
    payload: JSON.stringify({ name, password }),
  });
}

describe("accounts mode: public routes and 401", () => {
  it("only /health, /readyz, /v1/auth/state and login work without signing in; /metrics does not", async () => {
    const { app } = await makeFixture();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503); // not started, but not 401
    const state = await app.inject({ method: "GET", url: "/v1/auth/state?x=1" });
    expect(state.json()).toEqual({ mode: "accounts", publicOrigin: PUBLIC_URL });
    expect(state.headers["cache-control"]).toBe("no-store");
    for (const [method, url] of [["GET", "/metrics"], ["GET", "/v1/sessions"], ["GET", "/v1/access"], ["GET", "/v1/auth/me"], ["POST", "/v1/auth/logout"], ["GET", "/v1/auth/state/"], ["GET", "/v1/mcp/oauth/callback"]] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toMatchObject({ code: "auth_required" });
    }
    expect((await app.inject({ method: "GET", url: "/v1/auth/me" })).headers["cache-control"]).toBe("no-store");
  });

  it("IP admission still comes first", async () => {
    const { app } = await makeFixture();
    for (const url of ["/health", "/v1/auth/state", "/v1/sessions"]) {
      expect((await app.inject({ method: "GET", url, remoteAddress: OUTSIDE_IP })).statusCode, url).toBe(403);
    }
  });
});

describe("accounts mode: login and cookie", () => {
  it("sets an HttpOnly, SameSite=Lax cookie named after the public port, without Secure on http", async () => {
    const { app, auth } = await makeFixture();
    const account = await auth.createAccount("mz", "admin", PASSWORD);
    const res = await login(app, "mz");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ account: { id: account.id, name: "mz", role: "admin" } });
    expect(res.headers["cache-control"]).toBe("no-store");
    const header = String(res.headers["set-cookie"]);
    expect(header).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`));
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: `other=1; ${cookieOf(res)}` } });
    expect(me.json()).toEqual({ account: { id: account.id, name: "mz", role: "admin" }, via: "cookie" });
  });

  it("login checks the request origin: exact trusted Origin, or Sec-Fetch-Site same-origin when there is no Origin", async () => {
    const { app, auth } = await makeFixture();
    await auth.createAccount("mz", "user", PASSWORD);
    for (const origin of [PHONE, DESKTOP, DEV]) expect((await login(app, "mz", PASSWORD, { origin })).statusCode, origin).toBe(200);
    for (const origin of ["http://evil.example", "null", "http://192.168.5.137:5180/", "http://192.168.5.137"]) {
      expect((await login(app, "mz", PASSWORD, { origin })).statusCode, origin).toBe(403);
    }
    const sameOrigin = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { ...JSON_HEADERS, "sec-fetch-site": "same-origin" }, payload: JSON.stringify({ name: "mz", password: PASSWORD }) });
    expect(sameOrigin.statusCode).toBe(200);
    const neither = await app.inject({ method: "POST", url: "/v1/auth/login", headers: JSON_HEADERS, payload: JSON.stringify({ name: "mz", password: PASSWORD }) });
    expect(neither.statusCode).toBe(403);
    const wrongOriginWithFetchSite = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { ...JSON_HEADERS, origin: "http://evil.example", "sec-fetch-site": "same-origin" }, payload: JSON.stringify({ name: "mz", password: PASSWORD }) });
    expect(wrongOriginWithFetchSite.statusCode).toBe(403);
  });

  it("an unknown name, a wrong password and a disabled account answer the same 401, then back off with Retry-After", async () => {
    const { app, auth } = await makeFixture();
    await auth.createAccount("mz", "user", PASSWORD);
    await auth.createAccount("off", "user", PASSWORD);
    await auth.disable("off");
    const bodies = [];
    for (const [name, password, ip] of [["ghost", PASSWORD, "10.0.1.1"], ["mz", "wrong password!", "10.0.1.2"], ["off", PASSWORD, "10.0.1.3"]] as const) {
      const res = await login(app, name, password, { remoteAddress: ip });
      expect(res.statusCode, name).toBe(401);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ code: "invalid_credentials" });
    // The same IP is now backing off, even for the right password of another account.
    const byIp = await login(app, "mz", PASSWORD, { remoteAddress: "10.0.1.1" });
    expect(byIp.statusCode).toBe(429);
    expect(byIp.headers["retry-after"]).toBe("1");
    // The same name is backing off from another IP too.
    const byName = await login(app, "mz", PASSWORD, { remoteAddress: "10.0.1.9" });
    expect(byName.statusCode).toBe(429);
  });

  it("a third login while two scrypt computations run gets 429 Retry-After: 1 and is not counted as a failure", async () => {
    const { app, auth } = await makeFixture();
    for (const name of ["a1", "a2", "a3"]) await auth.createAccount(name, "user", PASSWORD);
    const results = await Promise.all(["a1", "a2", "a3"].map((name, i) => login(app, name, PASSWORD, { remoteAddress: `10.0.2.${i + 1}` })));
    const statuses = results.map(res => res.statusCode).sort();
    expect(statuses).toEqual([200, 200, 429]);
    const busy = results.find(res => res.statusCode === 429)!;
    expect(busy.headers["retry-after"]).toBe("1");
    expect(busy.json()).toMatchObject({ code: "login_busy" });
    const index = results.indexOf(busy);
    expect((await login(app, `a${index + 1}`, PASSWORD, { remoteAddress: `10.0.2.${index + 1}` })).statusCode).toBe(200);
  });

  it("rejects bodies over 4 KiB and missing fields", async () => {
    const { app } = await makeFixture();
    const big = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { ...JSON_HEADERS, origin: PHONE }, payload: JSON.stringify({ name: "mz", password: "x".repeat(5000) }) });
    expect(big.statusCode).toBe(413);
    const missing = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { ...JSON_HEADERS, origin: PHONE }, payload: JSON.stringify({ name: "mz" }) });
    expect(missing.statusCode).toBe(400);
  });
});

describe("accounts mode: credentials, CSRF and roles", () => {
  it("cookie and personal token map to the same owner; cookie writes need a trusted origin, token writes do not", async () => {
    const { app, auth } = await makeFixture();
    const account = await auth.createAccount("mz", "user", PASSWORD);
    const cookie = cookieOf(await login(app, "mz"));
    const { token } = await auth.issueToken("mz", "claude-desktop");

    const noOrigin = await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, cookie }, payload: "{}" });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json()).toMatchObject({ code: "csrf_rejected" });
    for (const origin of ["http://evil.example", "null"]) {
      expect((await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, cookie, origin }, payload: "{}" })).statusCode, origin).toBe(403);
    }
    const viaCookie = await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, cookie, origin: DEV }, payload: "{}" });
    expect(viaCookie.statusCode).toBe(201);
    expect(viaCookie.json().ownerKey).toBe(`user:${account.id}`);
    const viaFetchSite = await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, cookie, "sec-fetch-site": "same-origin" }, payload: "{}" });
    expect(viaFetchSite.statusCode).toBe(201);
    const viaToken = await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` }, payload: "{}" });
    expect(viaToken.statusCode).toBe(201);
    expect(viaToken.json().ownerKey).toBe(`user:${account.id}`);

    // From any device the same account sees the same sessions.
    const fromPhone = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "192.168.5.20", headers: { cookie } });
    const fromBridge = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${token}` } });
    expect(fromPhone.json().map((s: { id: string }) => s.id).sort()).toEqual(fromBridge.json().map((s: { id: string }) => s.id).sort());
    expect(fromPhone.json()).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } })).json().via).toBe("token");
  });

  it("an invalid cookie or token is 401; a bad token is not rescued by a valid cookie", async () => {
    const { app, auth } = await makeFixture();
    await auth.createAccount("mz", "user", PASSWORD);
    const cookie = cookieOf(await login(app, "mz"));
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: { cookie: `${COOKIE}=forged` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: { authorization: "Bearer pi_forged" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: { authorization: "Bearer pi_forged", cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: { cookie: cookie.replace(COOKIE, "pi_session_5173") } })).statusCode).toBe(401);
  });

  it("applies the account role to the existing RBAC matrix", async () => {
    const { app, auth } = await makeFixture();
    const tokens: Record<string, string> = {};
    for (const role of ["admin", "user", "viewer", "operator"] as const) {
      await auth.createAccount(role, role, PASSWORD);
      tokens[role] = (await auth.issueToken(role, "test")).token;
    }
    const call = (role: string, method: "GET" | "POST", url: string) =>
      app.inject({ method, url, headers: { ...JSON_HEADERS, authorization: `Bearer ${tokens[role]}` }, ...(method === "POST" ? { payload: "{}" } : {}) }).then(res => res.statusCode);
    expect(await call("admin", "GET", "/metrics")).toBe(200);
    expect(await call("operator", "GET", "/metrics")).toBe(200);
    expect(await call("user", "GET", "/metrics")).toBe(403);
    expect(await call("viewer", "GET", "/v1/sessions")).toBe(200);
    expect(await call("viewer", "POST", "/v1/sessions")).toBe(403);
    expect(await call("operator", "GET", "/v1/sessions")).toBe(403);
    expect(await call("user", "POST", "/v1/sessions")).toBe(201);
    for (const role of ["admin", "user", "viewer", "operator"]) expect(await call(role, "GET", "/v1/auth/me"), role).toBe(200);
  });

  it("changes made outside the request (disable, role, revoke, kick) apply to the next request", async () => {
    const { app, auth } = await makeFixture();
    await auth.createAccount("mz", "user", PASSWORD);
    const cookieRes = await login(app, "mz");
    const cookie = cookieOf(cookieRes);
    const issued = await auth.issueToken("mz", "bridge");
    const bearer = { authorization: `Bearer ${issued.token}` };
    expect((await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, ...bearer }, payload: "{}" })).statusCode).toBe(201);
    await auth.setRole("mz", "viewer");
    expect((await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, ...bearer }, payload: "{}" })).statusCode).toBe(403);
    await auth.revokeToken(issued.record.id);
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: bearer })).statusCode).toBe(401);
    const [session] = await auth.listSessions("mz");
    await auth.kick(session!.id);
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: { cookie } })).statusCode).toBe(401);
    const again = cookieOf(await login(app, "mz", PASSWORD, { remoteAddress: "10.0.3.1" }));
    await auth.disable("mz");
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: { cookie: again } })).statusCode).toBe(401);
  });

  it("a failing account lookup answers 503, not 401", async () => {
    const { app, auth, failLookups } = await makeFixture();
    await auth.createAccount("mz", "user", PASSWORD);
    const cookie = cookieOf(await login(app, "mz"));
    failLookups.on = true;
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: { cookie } })).statusCode).toBe(503);
  });
});

describe("accounts mode: logout and password", () => {
  it("logout ends this browser only and clears the cookie", async () => {
    const { app, auth } = await makeFixture();
    await auth.createAccount("mz", "user", PASSWORD);
    const mine = cookieOf(await login(app, "mz"));
    const other = cookieOf(await login(app, "mz"));
    const out = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie: mine, origin: PHONE } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toBe(`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: mine } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: other } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie: other } })).statusCode).toBe(403); // CSRF
  });

  it("changing the password needs a cookie and the current password; every browser is signed out and this one gets a new cookie", async () => {
    const { app, auth } = await makeFixture();
    await auth.createAccount("mz", "user", PASSWORD);
    const mine = cookieOf(await login(app, "mz"));
    const other = cookieOf(await login(app, "mz"));
    const { token } = await auth.issueToken("mz", "bridge");
    const put = (headers: Record<string, string>, current: string, next: string) =>
      app.inject({ method: "PUT", url: "/v1/auth/password", headers: { ...JSON_HEADERS, origin: PHONE, ...headers }, payload: JSON.stringify({ current, next }) });
    expect((await put({ authorization: `Bearer ${token}` }, PASSWORD, "brand new password")).json()).toMatchObject({ code: "cookie_required" });
    expect((await put({ cookie: mine }, PASSWORD, "short")).json()).toMatchObject({ code: "password_too_weak" });
    expect((await put({ cookie: mine }, "wrong password!", "brand new password")).json()).toMatchObject({ code: "invalid_current_password" });
    // The wrong current password above started a backoff for this name.
    expect((await put({ cookie: mine }, PASSWORD, "brand new password")).statusCode).toBe(429);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const changed = await put({ cookie: mine }, PASSWORD, "brand new password");
    expect(changed.statusCode).toBe(204);
    const renewed = cookieOf(changed);
    for (const old of [mine, other]) expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: old } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: renewed } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await login(app, "mz", "brand new password", { remoteAddress: "10.0.4.1" })).statusCode).toBe(200);
  });
});

describe("accounts mode: open event streams", () => {
  async function openStream(port: number, sessionId: string, headers: Record<string, string>) {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/events`, { headers, signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    return {
      /** Reads until the server closes the stream (or the timeout aborts it); returns the text. */
      async readToEnd(timeoutMs = 3000): Promise<{ text: string; closedByServer: boolean }> {
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let text = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return { text, closedByServer: true };
            text += decoder.decode(value, { stream: true });
          }
        } catch {
          return { text, closedByServer: false };
        } finally {
          clearTimeout(timer);
        }
      },
      close: () => controller.abort(),
    };
  }

  async function listening(fixture: Fixture): Promise<number> {
    await fixture.app.listen({ port: 0, host: "127.0.0.1" });
    const address = fixture.app.server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  async function newSession(app: FastifyInstance, token: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/v1/sessions", headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` }, payload: "{}" });
    return res.json().id;
  }

  it("closes the stream with auth_expired when the account is disabled, without aborting the agent", async () => {
    const fixture = await makeFixture({ recheckMs: 50 });
    const port = await listening(fixture);
    await fixture.auth.createAccount("mz", "user", PASSWORD);
    const { token } = await fixture.auth.issueToken("mz", "bridge");
    const cookie = cookieOf(await login(fixture.app, "mz"));
    const id = await newSession(fixture.app, token);
    const stream = await openStream(port, id, { cookie });
    await fixture.auth.disable("mz");
    const { text, closedByServer } = await stream.readToEnd();
    expect(closedByServer).toBe(true);
    expect(text).toContain('data: {"type":"auth_expired"}');
    expect(fixture.adapters.flatMap(adapter => adapter.calls).some(call => call.method === "abort")).toBe(false);
  });

  it("closes the stream when the role no longer allows events, or the check fails, and keeps a valid one open", async () => {
    const fixture = await makeFixture({ recheckMs: 50 });
    const port = await listening(fixture);
    await fixture.auth.createAccount("mz", "user", PASSWORD);
    const { token } = await fixture.auth.issueToken("mz", "bridge");
    const id = await newSession(fixture.app, token);

    const kept = await openStream(port, id, { authorization: `Bearer ${token}` });
    const stillOpen = await kept.readToEnd(300);
    expect(stillOpen.closedByServer).toBe(false);

    const demoted = await openStream(port, id, { authorization: `Bearer ${token}` });
    await fixture.auth.setRole("mz", "operator");
    expect((await demoted.readToEnd()).closedByServer).toBe(true);
    await fixture.auth.setRole("mz", "user");

    const failing = await openStream(port, id, { authorization: `Bearer ${token}` });
    fixture.failLookups.on = true;
    const closed = await failing.readToEnd();
    fixture.failLookups.on = false;
    expect(closed.closedByServer).toBe(true);
    expect(closed.text).toContain("auth_expired");
  });
});

describe("accounts mode: configuration", () => {
  it("refuses an IP policy that sets roles or tokens, and a missing account service", async () => {
    const storage = await makeInitializedMemoryDb();
    const authConfig = resolveAuthConfig({ mode: "accounts", publicUrl: PUBLIC_URL });
    const base = { sessions: storage.sessions, projects: storage.projects, defaultProjectCwd: "/tmp/default-project", createAdapter: async () => new MockAgentAdapter(), authConfig };
    const auth = new AuthService(new KyselyAccountRepository(storage.kysely, "sqlite"));
    expect(() => buildApp({ ...base, ipAccess: makeTestIpAccess() })).toThrow(/账号认证服务/);
    for (const entry of [{ ip: "127.0.0.1", role: "admin" as const }, { ip: "127.0.0.1", tokenRequired: true, tokens: ["t"] }]) {
      expect(() => buildApp({ ...base, accountAuth: auth, ipAccess: makeTestIpAccess({ policy: makePolicy([entry]) }) })).toThrow(/只做准入/);
    }
    const disabledOnly = buildApp({ ...base, accountAuth: auth, ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "10.0.0.9", disabled: true }]) }) });
    apps.push(disabledOnly);
    expect((await disabledOnly.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.9" })).statusCode).toBe(403);
  });
});

describe("ip mode keeps the auth routes off", () => {
  it("reports mode ip and answers 404 auth_not_enabled elsewhere", async () => {
    const storage = await makeInitializedMemoryDb();
    const app = buildApp({ sessions: storage.sessions, projects: storage.projects, defaultProjectCwd: "/tmp/default-project", ipAccess: makeTestIpAccess(), createAdapter: async () => new MockAgentAdapter() });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/v1/auth/state" })).json()).toEqual({ mode: "ip" });
    for (const [method, url] of [["POST", "/v1/auth/login"], ["POST", "/v1/auth/logout"], ["GET", "/v1/auth/me"], ["PUT", "/v1/auth/password"]] as const) {
      const res = await app.inject({ method, url, headers: { ...JSON_HEADERS, origin: PHONE }, payload: "{}" });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ code: "auth_not_enabled" });
    }
    const created = await app.inject({ method: "POST", url: "/v1/sessions", headers: JSON_HEADERS, payload: "{}" });
    expect(created.json().ownerKey).toBe("ip:127.0.0.1");
  });
});
