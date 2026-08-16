import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import type { Authenticate } from "../../src/server/auth.js";
import { identityKey, type UserIdentity } from "../../src/core/user-identity.js";
import type { SessionRecord, SessionRepository } from "../../src/storage/session-repository.js";
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";

// 可配置假鉴权：按 Authorization header 决定身份（内网按 IP / 公网按账号），
// 语义对齐 README §4.2——Token 校验通过后身份取自 IP 或账号；无/无效 token 抛错 → 401。
function buildFakeAuthenticate(users: Record<string, UserIdentity>): Authenticate {
  return async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new Error("缺少 Bearer Token");
    }
    const token = header.slice("Bearer ".length);
    const identity = users[token];
    if (!identity) throw new Error("未知 Token");
    return identity;
  };
}

const TOKEN_IP = "token-intranet";
const TOKEN_ACCT = "token-public";
const IP_IDENTITY: UserIdentity = { kind: "ip", ip: "10.0.0.1" };
const ACCT_IDENTITY: UserIdentity = { kind: "account", accountId: "acct-42" };

function makeApp(): { app: FastifyInstance; sessions: SessionRepository } {
  const db = new DatabaseSync(":memory:");
  const sessions = new SqliteSessionRepository(db);
  const app = buildApp({
    sessions,
    authenticate: buildFakeAuthenticate({
      [TOKEN_IP]: IP_IDENTITY,
      [TOKEN_ACCT]: ACCT_IDENTITY,
    }),
    createAdapter: async () => new MockAgentAdapter(),
  });
  return { app, sessions };
}

const JSON_HEADERS = { "content-type": "application/json" };
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

async function createSession(
  app: FastifyInstance,
  token: string,
  title?: string,
): Promise<SessionRecord> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { ...authHeader(token), ...JSON_HEADERS },
    payload: JSON.stringify(title === undefined ? {} : { title }),
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("HTTP 层：鉴权与会话 CRUD（README §4.2）", () => {
  describe("GET /health", () => {
    it("免鉴权返回 { status: ok }", async () => {
      const { app } = makeApp();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    });
  });

  describe("鉴权边界", () => {
    it("无 token 访问 /v1/sessions 返回 401", async () => {
      const { app } = makeApp();
      const res = await app.inject({ method: "GET", url: "/v1/sessions" });
      expect(res.statusCode).toBe(401);
    });

    it("无效 token 访问 /v1/sessions 返回 401", async () => {
      const { app } = makeApp();
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        headers: authHeader("token-wrong"),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /v1/sessions", () => {
    it("创建会话返回 201 且字段完整", async () => {
      const { app } = makeApp();
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...authHeader(TOKEN_IP), ...JSON_HEADERS },
        payload: JSON.stringify({ title: "项目 alpha" }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toEqual(expect.any(String));
      expect(body.ownerKey).toBe(identityKey(IP_IDENTITY));
      expect(body.title).toBe("项目 alpha");
      expect(body.createdAt).toEqual(expect.any(Number));
      expect(body.updatedAt).toEqual(expect.any(Number));
      expect(body.updatedAt).toBeGreaterThanOrEqual(body.createdAt);
    });

    it("公网账号创建会话 ownerKey 为 account: 前缀", async () => {
      const { app } = makeApp();
      const created = await createSession(app, TOKEN_ACCT, "公网会话");
      expect(created.ownerKey).toBe(identityKey(ACCT_IDENTITY));
    });

    it("未传 title 时默认空标题", async () => {
      const { app } = makeApp();
      const created = await createSession(app, TOKEN_IP);
      expect(created.title).toBe("");
    });
  });

  describe("GET /v1/sessions", () => {
    it("只返回当前用户会话，且按 updatedAt 降序", async () => {
      const { app, sessions } = makeApp();
      // 直接经注入的 repository 预置不同 updatedAt 的记录，验证排序与用户隔离
      const owner = identityKey(IP_IDENTITY);
      const other = identityKey(ACCT_IDENTITY);
      for (const rec of [
        { id: "s-old", ownerKey: owner, title: "旧", createdAt: 1000, updatedAt: 1000, piSessionFile: null },
        { id: "s-new", ownerKey: owner, title: "新", createdAt: 3000, updatedAt: 3000, piSessionFile: null },
        { id: "s-mid", ownerKey: owner, title: "中", createdAt: 2000, updatedAt: 2000, piSessionFile: null },
        { id: "s-other", ownerKey: other, title: "他人", createdAt: 9999, updatedAt: 9999, piSessionFile: null },
      ]) {
        await sessions.create(rec);
      }

      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        headers: authHeader(TOKEN_IP),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.map((s: { id: string }) => s.id)).toEqual(["s-new", "s-mid", "s-old"]);
      expect(body.some((s: { id: string }) => s.id === "s-other")).toBe(false);
    });

    it("不同用户各自只能看到自己的会话", async () => {
      const { app } = makeApp();
      await createSession(app, TOKEN_IP, "我的");
      await createSession(app, TOKEN_ACCT, "别人的");

      const ipList = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        headers: authHeader(TOKEN_IP),
      });
      expect(ipList.json()).toHaveLength(1);
      expect(ipList.json()[0]).toMatchObject({ title: "我的", ownerKey: identityKey(IP_IDENTITY) });

      const acctList = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        headers: authHeader(TOKEN_ACCT),
      });
      expect(acctList.json()).toHaveLength(1);
      expect(acctList.json()[0]).toMatchObject({ title: "别人的", ownerKey: identityKey(ACCT_IDENTITY) });
    });
  });

  describe("DELETE /v1/sessions/:id", () => {
    it("删除自己的会话返回 204，列表不再包含且存储已删除", async () => {
      const { app, sessions } = makeApp();
      const { id } = await createSession(app, TOKEN_IP, "待删除");

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${id}`,
        headers: authHeader(TOKEN_IP),
      });
      expect(res.statusCode).toBe(204);

      expect(await sessions.get(id)).toBeNull();
      const list = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        headers: authHeader(TOKEN_IP),
      });
      expect(list.json().some((s: { id: string }) => s.id === id)).toBe(false);
    });

    it("删除不存在的会话返回 404", async () => {
      const { app } = makeApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/v1/sessions/no-such-id",
        headers: authHeader(TOKEN_IP),
      });
      expect(res.statusCode).toBe(404);
    });

    it("删除他人的会话返回 404 且记录保留", async () => {
      const { app, sessions } = makeApp();
      const { id } = await createSession(app, TOKEN_ACCT, "别人的");

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${id}`,
        headers: authHeader(TOKEN_IP),
      });
      expect(res.statusCode).toBe(404);
      expect(await sessions.get(id)).not.toBeNull();
    });
  });

  describe("PATCH /v1/sessions/:id", () => {
    it("重命名自己的会话返回 200 并反映新 title", async () => {
      const { app, sessions } = makeApp();
      const { id } = await createSession(app, TOKEN_IP, "旧标题");
      const before = await sessions.get(id);

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}`,
        headers: { ...authHeader(TOKEN_IP), ...JSON_HEADERS },
        payload: JSON.stringify({ title: "新标题" }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ id, ownerKey: identityKey(IP_IDENTITY), title: "新标题" });
      expect(body.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);

      const after = await sessions.get(id);
      expect(after?.title).toBe("新标题");
    });

    it("重命名不存在的会话返回 404", async () => {
      const { app } = makeApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/sessions/no-such-id",
        headers: { ...authHeader(TOKEN_IP), ...JSON_HEADERS },
        payload: JSON.stringify({ title: "任意" }),
      });
      expect(res.statusCode).toBe(404);
    });

    it("重命名他人的会话返回 404 且 title 不变", async () => {
      const { app, sessions } = makeApp();
      const { id } = await createSession(app, TOKEN_ACCT, "别人的");

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${id}`,
        headers: { ...authHeader(TOKEN_IP), ...JSON_HEADERS },
        payload: JSON.stringify({ title: "恶意改名" }),
      });
      expect(res.statusCode).toBe(404);
      expect((await sessions.get(id))?.title).toBe("别人的");
    });
  });
});