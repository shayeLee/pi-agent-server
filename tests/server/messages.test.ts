import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentAdapter } from "../../src/agent/agent-adapter.js";
import type { UserIdentity } from "../../src/core/user-identity.js";

const IDENTITY: UserIdentity = { kind: "account", accountId: "u1" };
const TOKEN = "token-1";
const OTHER_IDENTITY: UserIdentity = { kind: "account", accountId: "u2" };
const OTHER_TOKEN = "token-2";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** prompt 挂起直到 finishStream() 释放，便于观察 streaming 中间态。 */
class ManualAdapter extends MockAgentAdapter {
  private release?: () => void;
  override async prompt(text: string): Promise<void> {
    this.calls.push({ method: "prompt", text });
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  finishStream(): void {
    this.release?.();
  }
}

function makeApp(createAdapter: (sessionId: string) => Promise<AgentAdapter>): {
  app: FastifyInstance;
  adapters: Map<string, AgentAdapter>;
} {
  const db = new DatabaseSync(":memory:");
  const sessions = new SqliteSessionRepository(db);
  const adapters = new Map<string, AgentAdapter>();
  const app = buildApp({
    sessions,
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

async function createSession(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { ...authHeader(token), ...JSON_HEADERS },
    payload: JSON.stringify({ title: "聊天" }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function post(
  app: FastifyInstance,
  url: string,
  token: string,
  body?: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: "POST",
    url,
    headers: body === undefined ? authHeader(token) : { ...authHeader(token), ...JSON_HEADERS },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { statusCode: res.statusCode, body: res.body ? res.json() : undefined };
}

describe("HTTP 层：messages / steer / follow-ups / abort（README §4.2）", () => {
  describe("POST /v1/sessions/:id/messages", () => {
    it("提交消息返回 202 accepted，流式事件写入会话事件总线", async () => {
      const { app } = makeApp(async () => new MockAgentAdapter([
        { type: "agent_start" },
        { type: "agent_end", messages: [], willRetry: false },
      ]));
      const id = await createSession(app, TOKEN);

      const res = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r1",
        prompt: "你好",
      });
      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ status: "accepted" });
    });

    it("重复 requestId（任务完成后）返回 200 done 不重复执行", async () => {
      const { app, adapters } = makeApp(async () => new MockAgentAdapter([
        { type: "agent_end", messages: [], willRetry: false },
      ]));
      const id = await createSession(app, TOKEN);

      const first = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r1",
        prompt: "首次",
      });
      expect(first.statusCode).toBe(202);
      await flush(); // 等待后台流式完成、幂等落账

      const second = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r1",
        prompt: "重复",
      });
      expect(second.statusCode).toBe(200);
      expect(second.body).toEqual({ status: "completed" });
      // 未重复执行：prompt 只调用一次
      const adapter = adapters.get(id) as MockAgentAdapter;
      expect(adapter.calls.filter((c) => c.method === "prompt")).toHaveLength(1);
    });

    it("缺少 requestId 返回 400", async () => {
      const { app } = makeApp(async () => new MockAgentAdapter());
      const id = await createSession(app, TOKEN);
      const res = await post(app, `/v1/sessions/${id}/messages`, TOKEN, { prompt: "x" });
      expect(res.statusCode).toBe(400);
    });

    it("带 images 提交返回 202 且 adapter 记录 images", async () => {
      const { app, adapters } = makeApp(async () => new MockAgentAdapter());
      const id = await createSession(app, TOKEN);
      const images = [
        { mediaType: "image/png", base64: "aGVsbG8=" },
        { mediaType: "image/jpeg", base64: "d29ybGQ=" },
      ];

      const res = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r1",
        prompt: "看图",
        images,
      });
      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ status: "accepted" });

      const adapter = adapters.get(id) as MockAgentAdapter;
      expect(adapter.calls).toEqual([{ method: "prompt", text: "看图", images }]);
    });

    it("不存在的会话返回 404", async () => {
      const { app } = makeApp(async () => new MockAgentAdapter());
      const res = await post(app, "/v1/sessions/no-such/messages", TOKEN, {
        requestId: "r1",
        prompt: "x",
      });
      expect(res.statusCode).toBe(404);
    });

    it("他人的会话返回 404", async () => {
      const { app } = makeApp(async () => new MockAgentAdapter());
      const id = await createSession(app, OTHER_TOKEN);
      const res = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r1",
        prompt: "x",
      });
      expect(res.statusCode).toBe(404);
    });

    it("流式中再次提交返回 409", async () => {
      const { app } = makeApp(async () => new ManualAdapter());
      const id = await createSession(app, TOKEN);

      const first = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r1",
        prompt: "挂起的问题",
      });
      expect(first.statusCode).toBe(202);

      const second = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r2",
        prompt: "冲突",
      });
      expect(second.statusCode).toBe(409);
    });
  });

  describe("steer / follow-ups / abort", () => {
    it("空闲时 steer/follow-up/abort 返回 409", async () => {
      const { app } = makeApp(async () => new MockAgentAdapter());
      const id = await createSession(app, TOKEN);

      expect((await post(app, `/v1/sessions/${id}/steer`, TOKEN, { text: "改" })).statusCode).toBe(409);
      expect((await post(app, `/v1/sessions/${id}/follow-ups`, TOKEN, { text: "追加" })).statusCode).toBe(409);
      expect((await post(app, `/v1/sessions/${id}/abort`, TOKEN)).statusCode).toBe(409);
    });

    it("流式中 steer/follow-up 返回 204 并转发 adapter", async () => {
      const { app, adapters } = makeApp(async () => new ManualAdapter());
      const id = await createSession(app, TOKEN);

      const first = await post(app, `/v1/sessions/${id}/messages`, TOKEN, {
        requestId: "r1",
        prompt: "问题",
      });
      expect(first.statusCode).toBe(202);

      expect((await post(app, `/v1/sessions/${id}/steer`, TOKEN, { text: "打断" })).statusCode).toBe(204);
      expect((await post(app, `/v1/sessions/${id}/follow-ups`, TOKEN, { text: "追加" })).statusCode).toBe(204);

      const adapter = adapters.get(id) as ManualAdapter;
      expect(adapter.calls).toEqual([
        { method: "prompt", text: "问题" },
        { method: "steer", text: "打断" },
        { method: "followUp", text: "追加" },
      ]);

      // 清理挂起的流式
      await post(app, `/v1/sessions/${id}/abort`, TOKEN);
      adapter.finishStream();
      await flush();
    });

    it("流式中 abort 返回 204 并中止", async () => {
      const { app, adapters } = makeApp(async () => new ManualAdapter());
      const id = await createSession(app, TOKEN);

      await post(app, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "r1", prompt: "问题" });
      const abort = await post(app, `/v1/sessions/${id}/abort`, TOKEN);
      expect(abort.statusCode).toBe(204);

      const adapter = adapters.get(id) as ManualAdapter;
      expect(adapter.aborted).toBe(true);
      adapter.finishStream();
      await flush();
    });

    it("他人会话的 steer 返回 404", async () => {
      const { app } = makeApp(async () => new MockAgentAdapter());
      const id = await createSession(app, OTHER_TOKEN);
      const res = await post(app, `/v1/sessions/${id}/steer`, TOKEN, { text: "越权" });
      expect(res.statusCode).toBe(404);
    });
  });
});
