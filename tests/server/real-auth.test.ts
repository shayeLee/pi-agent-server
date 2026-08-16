import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyRequest } from "fastify";
import { buildAuthenticate } from "../../src/server/real-auth.js";
import { buildApp } from "../../src/server/app.js";
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";

// 真实鉴权（README §4.2）：内网免 token（按 IP 识别），公网校验 Bearer Token（按账号识别）
const INTRA_CIDRS = ["10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12"];
const TOKENS: Record<string, string> = {
  "token-intranet": "acct-1",
  "token-public": "acct-42",
};

function makeAuthenticate() {
  return buildAuthenticate({ intranetCidrs: INTRA_CIDRS, tokens: TOKENS });
}

function req(ip: string, authorization?: string): FastifyRequest {
  return {
    ip,
    headers: authorization === undefined ? {} : { authorization },
  } as FastifyRequest;
}

describe("buildAuthenticate（内网免 token，公网校验 token）", () => {
  it("内网 IP 无 token → ip 身份（免登录）", async () => {
    const auth = makeAuthenticate();
    await expect(auth(req("10.1.2.3"))).resolves.toEqual({ kind: "ip", ip: "10.1.2.3" });
  });

  it("内网 IP + token → ip 身份（token 被忽略）", async () => {
    const auth = makeAuthenticate();
    await expect(auth(req("192.168.1.5", "Bearer token-public"))).resolves.toEqual({
      kind: "ip",
      ip: "192.168.1.5",
    });
  });

  it("公网 IP + 有效 token → account 身份", async () => {
    const auth = makeAuthenticate();
    await expect(auth(req("203.0.113.5", "Bearer token-public"))).resolves.toEqual({
      kind: "account",
      accountId: "acct-42",
    });
  });

  it("公网缺 Authorization → 抛错（上层 401）", async () => {
    const auth = makeAuthenticate();
    await expect(auth(req("203.0.113.5"))).rejects.toThrow();
    await expect(auth(req("203.0.113.5", ""))).rejects.toThrow();
  });

  it("公网非 Bearer（Basic / 裸 token / 小写） → 抛错", async () => {
    const auth = makeAuthenticate();
    await expect(auth(req("203.0.113.5", "Basic abc"))).rejects.toThrow();
    await expect(auth(req("203.0.113.5", "token-public"))).rejects.toThrow();
    await expect(auth(req("203.0.113.5", "bearer token-public"))).rejects.toThrow();
  });

  it("公网未知 token → 抛错", async () => {
    const auth = makeAuthenticate();
    await expect(auth(req("203.0.113.5", "Bearer unknown-token"))).rejects.toThrow();
  });

  it("空内网网段表：所有来源按公网处理（需 token）", async () => {
    const auth = buildAuthenticate({ intranetCidrs: [], tokens: TOKENS });
    await expect(auth(req("10.1.2.3", "Bearer token-public"))).resolves.toEqual({
      kind: "account",
      accountId: "acct-42",
    });
  });
});

describe("buildAuthenticate 经 Fastify（remoteAddress → request.ip）", () => {
  it("内网 IP 无 token → ip 身份", async () => {
    const app = Fastify();
    app.get("/identify", async (request) => makeAuthenticate()(request));
    const res = await app.inject({ method: "GET", url: "/identify", remoteAddress: "10.9.9.9" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: "ip", ip: "10.9.9.9" });
  });

  it("公网 IP + token → account 身份", async () => {
    const app = Fastify();
    app.get("/identify", async (request) => makeAuthenticate()(request));
    const res = await app.inject({
      method: "GET",
      url: "/identify",
      remoteAddress: "203.0.113.9",
      headers: { authorization: "Bearer token-public" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: "account", accountId: "acct-42" });
  });
});

describe("buildAuthenticate 接入 buildApp 完整链路", () => {
  function makeApp() {
    const db = new DatabaseSync(":memory:");
    const sessions = new SqliteSessionRepository(db);
    const app = buildApp({
      sessions,
      authenticate: makeAuthenticate(),
      createAdapter: async () => new MockAgentAdapter(),
    });
    return { app };
  }

  it("内网 remoteAddress 无 token → 创建会话，ownerKey 为 ip 身份", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      remoteAddress: "10.1.2.3",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ownerKey).toBe("ip:10.1.2.3");
  });

  it("公网 remoteAddress + 有效 token → 创建会话，ownerKey 为 account 身份", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      remoteAddress: "203.0.113.9",
      headers: { authorization: "Bearer token-public", "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ownerKey).toBe("account:acct-42");
  });

  it("公网 IP 无 token → 401", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      remoteAddress: "203.0.113.9",
    });
    expect(res.statusCode).toBe(401);
  });

  it("公网未知 token → 401", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      remoteAddress: "203.0.113.9",
      headers: { authorization: "Bearer unknown-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});
