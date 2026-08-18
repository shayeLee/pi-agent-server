import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { SqliteProjectRepository } from "../../src/storage/sqlite-project-repository.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentAdapter } from "../../src/agent/agent-adapter.js";
import type { UserIdentity } from "../../src/core/user-identity.js";

const IDENTITY: UserIdentity = { kind: "account", accountId: "u1" };
const TOKEN = "token-1";
const OTHER_IDENTITY: UserIdentity = { kind: "account", accountId: "u2" };
const OTHER_TOKEN = "token-2";

function makeApp(createAdapter: (sessionId: string) => Promise<AgentAdapter>): {
  app: FastifyInstance;
  adapters: Map<string, AgentAdapter>;
} {
  const db = new DatabaseSync(":memory:");
  const projects = new SqliteProjectRepository(db);
  void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default-project", ownerKey: "", createdAt: 0 });
  const sessions = new SqliteSessionRepository(db);
  const adapters = new Map<string, AgentAdapter>();
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    authenticate: async (request) => {
      const h = request.headers.authorization;
      if (h === `Bearer ${TOKEN}`) return IDENTITY;
      if (h === `Bearer ${OTHER_TOKEN}`) return OTHER_IDENTITY;
      throw new Error("bad token");
    },
    createAdapter: async (sessionId) => {
      const adapter = await createAdapter(sessionId);
      adapters.set(sessionId, adapter);
      return adapter;
    },
  });
  return { app, adapters };
}

const JSON_HEADERS = { "content-type": "application/json" };
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function createSession(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { ...authHeader(token), ...JSON_HEADERS },
    payload: JSON.stringify({ title: "可导出" }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function get(
  app: FastifyInstance,
  url: string,
  token?: string,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: "GET",
    url,
    headers: token === undefined ? undefined : authHeader(token),
  });
  return { statusCode: res.statusCode, body: res.body ? res.json() : undefined };
}

describe("HTTP 层：会话导出（GET /v1/sessions/:id/export）", () => {
  it("本人导出返回 200 与 { messages, lastEventId }", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const { app } = makeApp(async () => {
      const adapter = new MockAgentAdapter();
      adapter.exportData = messages;
      return adapter;
    });
    const id = await createSession(app, TOKEN);

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages, lastEventId: 0 });
  });

  it("未发送过消息的会话导出默认返回空消息列表", async () => {
    const { app } = makeApp(async () => new MockAgentAdapter());
    const id = await createSession(app, TOKEN);

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages: [], lastEventId: 0 });
  });

  it("发消息后导出：lastEventId 非零（事件游标随事件写入递增）", async () => {
    const { app } = makeApp(async () => new MockAgentAdapter([
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: false },
    ]));
    const id = await createSession(app, TOKEN);

    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: { ...authHeader(TOKEN), ...JSON_HEADERS },
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await flush(); // 等待后台流式完成

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);
    expect(res.statusCode).toBe(200);
    expect((res.body as { lastEventId: number }).lastEventId).toBeGreaterThan(0);
  });

  it("他人的会话导出返回 404（越权不可见）", async () => {
    const { app } = makeApp(async () => new MockAgentAdapter());
    const id = await createSession(app, OTHER_TOKEN);

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);

    expect(res.statusCode).toBe(404);
  });

  it("不存在的会话导出返回 404", async () => {
    const { app } = makeApp(async () => new MockAgentAdapter());

    const res = await get(app, "/v1/sessions/no-such/export", TOKEN);

    expect(res.statusCode).toBe(404);
  });

  it("未鉴权导出返回 401", async () => {
    const { app } = makeApp(async () => new MockAgentAdapter());
    const id = await createSession(app, TOKEN);

    const res = await get(app, `/v1/sessions/${id}/export`);

    expect(res.statusCode).toBe(401);
  });
});