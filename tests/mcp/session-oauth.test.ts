import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { parseMcpCatalog } from "../../src/mcp/catalog.js";
import { McpOAuthConnections } from "../../src/mcp/oauth-connections.js";
import { KeyedLock, McpReauthorizationRequiredError } from "../../src/mcp/session-oauth.js";
import { McpTokenCipher } from "../../src/mcp/token-cipher.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { KyselyMcpOAuthRepository } from "../../src/storage/kysely-mcp-oauth-repository.js";
import { FakeAuthorizationServer, ISSUER, MCP } from "../fixtures/fake-oauth-server.js";

const A = "ip:10.0.0.1";
const catalog = parseMcpCatalog({ version: 1, servers: { example: { url: MCP, description: "Example", oauth: { label: "Example", scope: "read" } } } });
const unauthorized = (token: string | undefined, fetch: FakeAuthorizationServer["fetch"]) =>
  ({ response: new Response("", { status: 401 }), serverUrl: new URL(MCP), fetch, ...(token !== undefined ? { token } : {}) });

describe("KeyedLock", () => {
  it("runs tasks with the same key one at a time and keeps going after a failure", async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => { order.push(`${name}:start`); await new Promise(resolve => setTimeout(resolve, ms)); order.push(`${name}:end`); };
    await Promise.all([
      lock.run("k", slow("a", 20)),
      lock.run("k", async () => { order.push("b"); throw new Error("boom"); }).catch(() => {}),
      lock.run("k", slow("c", 1)),
      lock.run("other", async () => { order.push("other"); }),
    ]);
    expect(order.filter(item => item !== "other")).toEqual(["a:start", "a:end", "b", "c:start", "c:end"]);
    expect(order.indexOf("other")).toBeLessThan(order.indexOf("a:end"));
  });
});

describe("session auth provider", () => {
  let kysely: Kysely<DatabaseSchema>;
  let store: KyselyMcpOAuthRepository;
  let auth: FakeAuthorizationServer;
  let connections: McpOAuthConnections;
  let now: number;

  beforeEach(async () => {
    kysely = await initializeDatabase(new DatabaseSync(":memory:"));
    store = new KyselyMcpOAuthRepository(kysely, new McpTokenCipher(randomBytes(32)));
    auth = new FakeAuthorizationServer();
    now = 1_000_000;
    connections = new McpOAuthConnections({ catalog, secrets: new Map(), store, publicUrl: "https://pi.example.test", fetch: auth.fetch, now: () => now });
    const started = await connections.start(A, "example");
    if (!("authorizationUrl" in started)) throw new Error(started.message);
    const url = new URL(started.authorizationUrl);
    auth.codes.set("code", { clientId: url.searchParams.get("client_id")! });
    await connections.complete(A, { code: "code", state: url.searchParams.get("state")!, iss: ISSUER });
  });
  afterEach(async () => { await kysely.destroy(); });

  const refreshCount = () => auth.tokenRequests.filter(params => params.get("grant_type") === "refresh_token").length;

  it("lists the connected server and gives sessions the owner's token", async () => {
    expect(await connections.connectedServers(A)).toEqual(new Set(["example"]));
    expect(await connections.connectedServers("ip:10.0.0.2")).toEqual(new Set());
    expect(await connections.sessionAuthProvider(A, "example")!.token()).toBe("at-1");
    expect(connections.sessionAuthProvider(A, "nope")).toBeUndefined();
  });

  it("refreshes once, ahead of expiry, for several sessions of the same owner", async () => {
    now += 3_600_000 - 30_000;
    const sessions = [connections.sessionAuthProvider(A, "example")!, connections.sessionAuthProvider(A, "example")!];
    expect(await Promise.all(sessions.map(session => session.token()))).toEqual(["at-2", "at-2"]);
    expect(refreshCount()).toBe(1);
  });

  it("refreshes once when two sessions hit 401 with the same old token", async () => {
    const [one, two] = [connections.sessionAuthProvider(A, "example")!, connections.sessionAuthProvider(A, "example")!];
    await Promise.all([one.onUnauthorized!(unauthorized("at-1", auth.fetch)), two.onUnauthorized!(unauthorized("at-1", auth.fetch))]);
    expect(refreshCount()).toBe(1);
    expect(await two.token()).toBe("at-2");
  });

  it("asks for a new authorization in plain words once the grant is revoked", async () => {
    auth.refreshTokens.clear();
    const session = connections.sessionAuthProvider(A, "example")!;
    await expect(session.onUnauthorized!(unauthorized("at-1", auth.fetch))).rejects.toThrow(new McpReauthorizationRequiredError("Example"));
    expect(await connections.connectedServers(A)).toEqual(new Set());
    await expect(session.token()).rejects.toThrow("Example 授权已失效，请在 MCP 面板重新连接");
  });

  it("stops working right after the user disconnects", async () => {
    const session = connections.sessionAuthProvider(A, "example")!;
    await connections.disconnect(A, "example");
    await expect(session.token()).rejects.toBeInstanceOf(McpReauthorizationRequiredError);
  });
});
