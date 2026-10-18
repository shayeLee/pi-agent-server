import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { parseMcpCatalog } from "../../src/mcp/catalog.js";
import { McpOAuthConnections, parsePublicUrl } from "../../src/mcp/oauth-connections.js";
import { McpTokenCipher } from "../../src/mcp/token-cipher.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { KyselyMcpOAuthRepository } from "../../src/storage/kysely-mcp-oauth-repository.js";
import { FakeAuthorizationServer, ISSUER, MCP } from "../fixtures/fake-oauth-server.js";

const A = "ip:10.0.0.1";
const B = "ip:10.0.0.2";
const PUBLIC = "https://pi.example.test";
const catalog = parseMcpCatalog({ version: 1, servers: {
  example: { url: MCP, description: "Example", oauth: { label: "Example", scope: "read" } },
  docs: { url: "https://docs.example.com/mcp", description: "Docs" },
} });

describe("parsePublicUrl", () => {
  it("normalizes the address and flags plain http outside loopback", () => {
    expect(parsePublicUrl("https://pi.example.test/")).toEqual({ url: "https://pi.example.test", insecure: false });
    expect(parsePublicUrl("https://pi.example.test/agent/")).toEqual({ url: "https://pi.example.test/agent", insecure: false });
    expect(parsePublicUrl("http://127.0.0.1:5173")).toEqual({ url: "http://127.0.0.1:5173", insecure: false });
    expect(parsePublicUrl("http://192.168.1.10:5180")).toEqual({ url: "http://192.168.1.10:5180", insecure: true });
    expect(() => parsePublicUrl("pi.example.test")).toThrow(/absolute http or https/);
    expect(() => parsePublicUrl("https://pi.example.test/?a=1")).toThrow(/query or a fragment/);
  });
});

describe("McpOAuthConnections", () => {
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

  const connections = (publicUrl = PUBLIC) => new McpOAuthConnections({ catalog, secrets: new Map(), store, publicUrl, fetch: auth.fetch, now: () => now });

  /** start 后模拟用户在授权页点同意：返回回调里会带的 state 与 code。 */
  async function authorize(service: McpOAuthConnections, owner = A) {
    const started = await service.start(owner, "example");
    if (!("authorizationUrl" in started)) throw new Error(started.message);
    const url = new URL(started.authorizationUrl);
    auth.codes.set(`code-${url.searchParams.get("state")}`, { clientId: url.searchParams.get("client_id")! });
    return { url, state: url.searchParams.get("state")!, code: `code-${url.searchParams.get("state")}` };
  }

  it("lists only oauth servers and connects the caller through the public callback", async () => {
    const service = connections();
    expect(await service.list(A)).toEqual([{ name: "example", label: "Example", connected: false }]);
    const { url, state, code } = await authorize(service);
    expect(url.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/v1/mcp/oauth/callback`);
    expect(await service.complete(A, { code, state, iss: ISSUER })).toEqual({ ok: true, server: "example" });
    expect(await service.list(A)).toEqual([{ name: "example", label: "Example", connected: true, account: "someone@example.com", connectedAt: now, expiresAt: now + 3_600_000 }]);
    expect(await service.list(B)).toEqual([{ name: "example", label: "Example", connected: false }]);
  });

  it("lets only the caller who started use the state, once, within 10 minutes", async () => {
    const service = connections();
    const first = await authorize(service);
    // 别人拿到 state 用不了，也不会把它作废。
    expect(await service.complete(B, { code: first.code, state: first.state, iss: ISSUER })).toEqual({ ok: false, reason: "expired" });
    expect(await service.complete(A, { code: first.code, state: first.state, iss: ISSUER })).toMatchObject({ ok: true });
    expect(await service.complete(A, { code: first.code, state: first.state, iss: ISSUER })).toEqual({ ok: false, reason: "expired" });
    expect(await service.complete(A, { code: "x", iss: ISSUER })).toEqual({ ok: false, reason: "expired" });

    const late = await authorize(service);
    now += 10 * 60_000;
    expect(await service.complete(A, { code: late.code, state: late.state, iss: ISSUER })).toEqual({ ok: false, reason: "expired" });
  });

  it("keeps the last five pending authorizations per caller", async () => {
    const service = connections();
    const states = [];
    for (let i = 0; i < 6; i++) states.push(await authorize(service));
    expect(await service.complete(A, { code: states[0]!.code, state: states[0]!.state, iss: ISSUER })).toEqual({ ok: false, reason: "expired" });
    expect(await service.complete(A, { code: states[1]!.code, state: states[1]!.state, iss: ISSUER })).toMatchObject({ ok: true });
  });

  it("reports a denied authorization and a callback from another issuer without storing anything", async () => {
    const service = connections();
    const denied = await authorize(service);
    expect(await service.complete(A, { state: denied.state, error: "access_denied" })).toEqual({ ok: false, server: "example", reason: "denied" });
    const forged = await authorize(service);
    expect(await service.complete(A, { code: forged.code, state: forged.state, iss: "https://evil.example.test" })).toEqual({ ok: false, server: "example", reason: "issuer_mismatch" });
    expect(await store.getCredential(A, "example")).toBeUndefined();
  });

  it("re-authorizes instead of refreshing when a connected caller connects again", async () => {
    const service = connections();
    const first = await authorize(service);
    await service.complete(A, { code: first.code, state: first.state, iss: ISSUER });
    const again = await service.start(A, "example");
    expect(again).toHaveProperty("authorizationUrl");
    expect(auth.tokenRequests.filter(params => params.get("grant_type") === "refresh_token")).toEqual([]);
  });

  it("explains that the authorization server wants an https callback", async () => {
    auth.rejectPlainHttpRedirects = true;
    expect(await connections("http://192.168.1.10:5180").start(A, "example")).toEqual({
      code: "registration_rejected", message: expect.stringContaining("HTTPS"),
    });
    expect(await connections("http://127.0.0.1:5173").start(A, "example")).toHaveProperty("authorizationUrl");
    expect(await connections().start(A, "docs")).toMatchObject({ code: "unknown_server" });
  });

  it("revokes both tokens and removes the credential on disconnect", async () => {
    const service = connections();
    const { code, state } = await authorize(service);
    await service.complete(A, { code, state, iss: ISSUER });
    expect(await service.disconnect(A, "example")).toBe(true);
    expect(auth.revocations.map(params => [params.get("token"), params.get("token_type_hint"), params.get("client_id")])).toEqual([
      ["rt-1", "refresh_token", "dcr-1"], ["at-1", "access_token", "dcr-1"],
    ]);
    expect(await service.list(A)).toEqual([{ name: "example", label: "Example", connected: false }]);
    expect(await service.disconnect(A, "example")).toBe(false);
  });
});
