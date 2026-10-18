import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adaptOAuthProvider, authorizeMcp, McpOAuthAuthorizationRequiredError, OAuthIssuerMismatchError,
} from "@earendil-works/pi-mcp/oauth";
import type { Kysely } from "kysely";
import { parseMcpCatalog } from "../../src/mcp/catalog.js";
import {
  isOAuthServer, mcpOAuthFlowOptions, StoredMcpOAuthProvider,
  type McpOAuthCatalogServer, type PendingMcpAuthorization,
} from "../../src/mcp/oauth-provider.js";
import { McpTokenCipher } from "../../src/mcp/token-cipher.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { KyselyMcpOAuthRepository } from "../../src/storage/kysely-mcp-oauth-repository.js";

const MCP = "https://mcp.example.test/mcp";
const ISSUER = "https://auth.example.test";
const OWNER = "ip:10.0.0.1";
const REDIRECT = "https://pi.example.test/v1/mcp/oauth/callback";

/** 一台最小的授权服务器：发现、动态注册、授权码换 token、刷新（轮换 refresh token）。 */
class FakeAuthorizationServer {
  registrations: Array<Record<string, unknown>> = [];
  tokenRequests: URLSearchParams[] = [];
  codes = new Map<string, { clientId: string }>();
  refreshTokens = new Map<string, number>();
  issued = 0;

  idToken(claims: Record<string, unknown>) {
    return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: MCP, authorization_servers: [ISSUER], scopes_supported: ["read", "write"] });
    }
    if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.href === `${ISSUER}/register` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.registrations.push(body);
      return json({ ...body, client_id: `dcr-${this.registrations.length}` }, 201);
    }
    if (url.href === `${ISSUER}/token` && init?.method === "POST") {
      const params = new URLSearchParams(String(init.body));
      this.tokenRequests.push(params);
      if (params.get("grant_type") === "authorization_code") {
        const code = this.codes.get(params.get("code") ?? "");
        if (!code || code.clientId !== params.get("client_id")) return json({ error: "invalid_grant", error_description: "bad code" }, 400);
        return json(this.#tokens({ id_token: this.idToken({ email: "someone@example.com" }) }));
      }
      if (params.get("grant_type") === "refresh_token") {
        const refresh = params.get("refresh_token") ?? "";
        if (!this.refreshTokens.delete(refresh)) return json({ error: "invalid_grant", error_description: "revoked" }, 400);
        return json(this.#tokens());
      }
    }
    return new Response("not found", { status: 404 });
  };

  #tokens(extra: Record<string, unknown> = {}) {
    this.issued++;
    const refresh = `rt-${this.issued}`;
    this.refreshTokens.set(refresh, this.issued);
    return { access_token: `at-${this.issued}`, token_type: "bearer", expires_in: 3600, refresh_token: refresh, ...extra };
  }
}

function catalogServer(oauth: Record<string, unknown> = { label: "Example", scope: "read" }): McpOAuthCatalogServer {
  const secrets = new Map([["EXAMPLE_SECRET", "s3cret"]]);
  const server = parseMcpCatalog({ version: 1, servers: { example: { url: MCP, description: "Example", oauth } } }, secrets).servers.get("example")!;
  if (!isOAuthServer(server)) throw new Error("not an oauth server");
  return server;
}

describe("StoredMcpOAuthProvider", () => {
  let kysely: Kysely<DatabaseSchema>;
  let store: KyselyMcpOAuthRepository;
  let auth: FakeAuthorizationServer;
  let now: number;

  beforeEach(async () => {
    kysely = await initializeDatabase(new DatabaseSync(":memory:"));
    store = new KyselyMcpOAuthRepository(kysely, new McpTokenCipher(randomBytes(32)));
    auth = new FakeAuthorizationServer();
    now = 1_000_000;
  });
  afterEach(async () => { await kysely.destroy(); });

  function provider(server: McpOAuthCatalogServer, extra: { pending?: PendingMcpAuthorization; redirectUrl?: string; onRedirect?: (url: URL) => void; clientSecret?: string } = {}) {
    return new StoredMcpOAuthProvider({
      store, ownerKey: OWNER, server, redirectUrl: extra.redirectUrl ?? REDIRECT, clientName: "pi-agent-server", now: () => now,
      ...(extra.pending ? { pending: extra.pending } : {}),
      ...(extra.onRedirect ? { onRedirect: extra.onRedirect } : {}),
      ...(extra.clientSecret !== undefined ? { clientSecret: extra.clientSecret } : {}),
    });
  }

  /** start 与 callback 两步，各用一个新的 provider 实例，只共享待处理状态。 */
  async function connect(server = catalogServer(), redirectUrl = REDIRECT) {
    const pending: PendingMcpAuthorization = {};
    let authorizationUrl: URL | undefined;
    const start = provider(server, { pending, redirectUrl, onRedirect: url => { authorizationUrl = url; } });
    expect(await authorizeMcp(start, { ...mcpOAuthFlowOptions(server), fetch: auth.fetch, skipRefresh: true })).toBe("REDIRECT");
    const clientId = authorizationUrl!.searchParams.get("client_id")!;
    auth.codes.set("code-1", { clientId });
    const callback = provider(server, { pending, redirectUrl });
    const result = await authorizeMcp(callback, { ...mcpOAuthFlowOptions(server), fetch: auth.fetch, authorizationCode: "code-1", iss: ISSUER });
    return { result, authorizationUrl: authorizationUrl!, pending };
  }

  it("registers a client, authorizes and stores the caller's tokens", async () => {
    const { result, authorizationUrl, pending } = await connect();
    expect(result).toBe("AUTHORIZED");
    expect(auth.registrations).toEqual([expect.objectContaining({ client_name: "pi-agent-server", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" })]);
    expect(authorizationUrl.searchParams.get("scope")).toBe("read");
    expect(authorizationUrl.searchParams.get("state")).toBe(pending.state);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(await store.getClient("example")).toMatchObject({ serverUrl: MCP, redirectUrl: REDIRECT, client: { client_id: "dcr-1" } });
    expect(await store.getCredential(OWNER, "example")).toEqual({
      ownerKey: OWNER, serverName: "example", serverUrl: MCP, clientId: "dcr-1", accountLabel: "someone@example.com",
      tokens: { access_token: "at-1", token_type: "bearer", expires_in: 3600, refresh_token: "rt-1", scope: "read" },
      expiresAt: now + 3_600_000, scope: "read", discovery: expect.objectContaining({ authorizationServerUrl: ISSUER }),
      createdAt: now, updatedAt: now,
    });
  });

  it("rejects a callback from another issuer and stores nothing", async () => {
    const server = catalogServer();
    const pending: PendingMcpAuthorization = {};
    await authorizeMcp(provider(server, { pending, onRedirect: () => {} }), { ...mcpOAuthFlowOptions(server), fetch: auth.fetch });
    auth.codes.set("code-1", { clientId: "dcr-1" });
    await expect(authorizeMcp(provider(server, { pending }), { ...mcpOAuthFlowOptions(server), fetch: auth.fetch, authorizationCode: "code-1", iss: "https://evil.example.test" }))
      .rejects.toBeInstanceOf(OAuthIssuerMismatchError);
    expect(await store.getCredential(OWNER, "example")).toBeUndefined();
  });

  it("refreshes in a session after a 401 and keeps the rotated refresh token", async () => {
    await connect();
    now += 3_600_000;
    const session = adaptOAuthProvider(provider(catalogServer()));
    expect(await session.token()).toBe("at-1");
    await session.onUnauthorized!({ response: new Response("", { status: 401 }), serverUrl: new URL(MCP), fetch: auth.fetch, token: "at-1" });
    expect(await session.token()).toBe("at-2");
    expect(await store.getCredential(OWNER, "example")).toMatchObject({
      tokens: { access_token: "at-2", refresh_token: "rt-2" }, accountLabel: "someone@example.com", scope: "read", expiresAt: now + 3_600_000,
    });
  });

  it("deletes the credential and asks for a new authorization when the refresh token is revoked", async () => {
    await connect();
    auth.refreshTokens.clear();
    const session = adaptOAuthProvider(provider(catalogServer()));
    await expect(session.onUnauthorized!({ response: new Response("", { status: 401 }), serverUrl: new URL(MCP), fetch: auth.fetch, token: "at-1" }))
      .rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
    expect(await store.getCredential(OWNER, "example")).toBeUndefined();
    // 客户端属于部署，不因一个用户的授权失效而删除。
    expect(await store.getClient("example")).toBeDefined();
  });

  it("registers again after PI_PUBLIC_URL changes", async () => {
    await connect();
    await connect(catalogServer(), "https://pi.other.test/v1/mcp/oauth/callback");
    expect(auth.registrations.map(body => body.redirect_uris)).toEqual([[REDIRECT], ["https://pi.other.test/v1/mcp/oauth/callback"]]);
    expect(await store.getCredential(OWNER, "example")).toMatchObject({ clientId: "dcr-2", createdAt: 1_000_000 });
  });

  it("ignores credentials stored for another server URL", async () => {
    await connect();
    const moved = parseMcpCatalog({ version: 1, servers: { example: { url: "https://mcp.example.test/v2/mcp", description: "Example", oauth: { label: "Example" } } } })
      .servers.get("example")!;
    expect(await provider(moved as McpOAuthCatalogServer).tokens()).toBeUndefined();
  });

  it("uses a pre-registered client without dynamic registration", async () => {
    const server = catalogServer({ label: "Example", clientId: "preset", clientSecret: "${secret:EXAMPLE_SECRET}" });
    const pending: PendingMcpAuthorization = {};
    let authorizationUrl: URL | undefined;
    await authorizeMcp(provider(server, { pending, clientSecret: "s3cret", onRedirect: url => { authorizationUrl = url; } }), { ...mcpOAuthFlowOptions(server), fetch: auth.fetch });
    expect(auth.registrations).toEqual([]);
    expect(authorizationUrl!.searchParams.get("client_id")).toBe("preset");
    auth.codes.set("code-1", { clientId: "preset" });
    await authorizeMcp(provider(server, { pending, clientSecret: "s3cret" }), { ...mcpOAuthFlowOptions(server), fetch: auth.fetch, authorizationCode: "code-1", iss: ISSUER });
    expect(auth.tokenRequests.at(-1)?.get("client_secret")).toBe("s3cret");
    expect(await store.getClient("example")).toBeUndefined();
    expect(await store.getCredential(OWNER, "example")).toMatchObject({ clientId: "preset" });
  });
});
