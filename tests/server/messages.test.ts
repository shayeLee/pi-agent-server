import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { SqliteProjectRepository } from "../../src/storage/sqlite-project-repository.js";
import { SqliteIdempotencyRepository } from "../../src/storage/sqlite-idempotency-repository.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentAdapter } from "../../src/agent/agent-adapter.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import type { IdempotencyStorePort } from "../../src/application/ports/index.js";
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

/** prompt 挂起、abort 抛错的 adapter：验证 abort 失败 → poisoned 会话拒绝复用（HTTP 409）。 */
class AbortThrowingManualAdapter extends ManualAdapter {
  override async abort(): Promise<void> {
    this.calls.push({ method: "abort" });
    throw new Error("abort 失败");
  }
}

function makeApp(
  createAdapter: (sessionId: string) => Promise<AgentAdapter>,
  options: {
    concurrency?: ConcurrencyController;
    db?: DatabaseSync;
    idempotencyRepo?: IdempotencyStorePort;
  } = {},
): {
  app: FastifyInstance;
  adapters: Map<string, AgentAdapter>;
} {
  const db = options.db ?? new DatabaseSync(":memory:");
  // 外键约束要求 projects 表先于 sessions 且含 'default' 行
  const projects = new SqliteProjectRepository(db);
  void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/default-project", ownerKey: "", createdAt: 0 });
  const sessions = new SqliteSessionRepository(db);
  const adapters = new Map<string, AgentAdapter>();
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    concurrency: options.concurrency,
    idempotencyRepo: options.idempotencyRepo,
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

describe("HTTP 层：messages / steer / follow-ups / abort（needs.md §4.2）", () => {
  describe("POST /v1/sessions/:id/messages", () => {
    it("提交消息返回 202 accepted，事件写入事件总线（导出 lastEventId > 0）", async () => {
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

      // 事件确实写入事件总线：完成后导出 lastEventId > 0
      await flush();
      const exported = await app.inject({
        method: "GET",
        url: `/v1/sessions/${id}/export`,
        headers: authHeader(TOKEN),
      });
      expect((exported.json() as { lastEventId: number }).lastEventId).toBeGreaterThan(0);
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

      await flush(); // 等待后台进入 adapter 后再断言调用
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

    it("同一 requestId 并发提交只执行一次（inFlightSubmits 去重）", async () => {
      const { app, adapters } = makeApp(async () => new ManualAdapter());
      const id = await createSession(app, TOKEN);

      const [r1, r2] = await Promise.all([
        post(app, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "same", prompt: "并发" }),
        post(app, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "same", prompt: "并发" }),
      ]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([202, 202]);

      const adapter = adapters.get(id) as ManualAdapter;
      expect(adapter.calls.filter((c) => c.method === "prompt")).toHaveLength(1);
      // 清理挂起的流式
      await post(app, `/v1/sessions/${id}/abort`, TOKEN);
      adapter.finishStream();
      await flush();
    });
  });

  describe("排队与限流（每用户 1 槽位 + 1 队列位）", () => {
    function makeQueuedApp() {
      const adapters = new Map<string, ManualAdapter>();
      const concurrency = new ConcurrencyController({
        globalLimit: 4,
        perUserLimit: 1,
        perUserQueueLimit: 1,
        globalQueueLimit: 10,
        queueTimeoutMs: 60_000,
      });
      const { app } = makeApp(async (sessionId) => {
        const adapter = new ManualAdapter();
        adapters.set(sessionId, adapter);
        return adapter;
      }, { concurrency });
      return { app, adapters };
    }

    it("占满槽位后排队（202 queued），队列满返回 429，前任务完成后出队执行", async () => {
      const { app, adapters } = makeQueuedApp();
      const a = await createSession(app, TOKEN);
      const b = await createSession(app, TOKEN);
      const c = await createSession(app, TOKEN);

      // 占用每用户唯一槽位
      const r1 = await post(app, `/v1/sessions/${a}/messages`, TOKEN, { requestId: "r1", prompt: "A" });
      expect(r1.statusCode).toBe(202);
      expect(r1.body).toEqual({ status: "accepted" });

      // 排队（每用户队列 1 位）
      const r2 = await post(app, `/v1/sessions/${b}/messages`, TOKEN, { requestId: "r2", prompt: "B" });
      expect(r2.statusCode).toBe(202);
      expect(r2.body).toMatchObject({ status: "queued" });

      // 队列满 → 429
      const r3 = await post(app, `/v1/sessions/${c}/messages`, TOKEN, { requestId: "r3", prompt: "C" });
      expect(r3.statusCode).toBe(429);

      // B 尚未执行
      expect(adapters.get(b)!.calls.filter((c) => c.method === "prompt")).toHaveLength(0);

      // 释放 A 槽位 → B 出队并开始执行
      adapters.get(a)!.finishStream();
      await flush();
      expect(adapters.get(b)!.calls.filter((c) => c.method === "prompt")).toHaveLength(1);

      // 清理 B 的挂起流式
      await post(app, `/v1/sessions/${b}/abort`, TOKEN);
      adapters.get(b)!.finishStream();
      await flush();
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

    it("abort 抛错 → poisoned：后续提交返回 409（会话任务异常）", async () => {
      const { app, adapters } = makeApp(async () => new AbortThrowingManualAdapter());
      const id = await createSession(app, TOKEN);

      await post(app, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "r1", prompt: "问题" });
      const abort = await post(app, `/v1/sessions/${id}/abort`, TOKEN);
      expect(abort.statusCode).toBe(204);
      await flush();

      const next = await post(app, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "r2", prompt: "再来" });
      expect(next.statusCode).toBe(409);
      expect(next.body).toEqual({
        statusCode: 409,
        error: "Conflict",
        message: "会话任务异常，请新建会话",
      });

      // 清理挂起的 prompt
      (adapters.get(id) as ManualAdapter).finishStream();
      await flush();
    });

    it("他人会话的 steer 返回 404", async () => {
      const { app } = makeApp(async () => new MockAgentAdapter());
      const id = await createSession(app, OTHER_TOKEN);
      const res = await post(app, `/v1/sessions/${id}/steer`, TOKEN, { text: "越权" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("删除活动会话：运行时清理", () => {
    it("删除活动会话中止并释放 adapter，且并发槽位可复用", async () => {
      const adapters = new Map<string, ManualAdapter>();
      const concurrency = new ConcurrencyController({
        globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 4, queueTimeoutMs: 60_000,
      });
      const { app } = makeApp(async (sessionId) => {
        const adapter = new ManualAdapter();
        adapters.set(sessionId, adapter);
        return adapter;
      }, { concurrency });

      const id = await createSession(app, TOKEN);
      await post(app, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "r1", prompt: "挂起" });

      const del = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${id}`,
        headers: authHeader(TOKEN),
      });
      expect(del.statusCode).toBe(204);

      // 活动任务被中止，adapter 被 dispose
      const calls = adapters.get(id)!.calls.map((c) => c.method);
      expect(calls).toContain("abort");
      expect(calls).toContain("dispose");

      // 并发槽位已释放：同一用户可再提交新任务（不因旧活动任务卡住）
      const id2 = await createSession(app, TOKEN);
      const res = await post(app, `/v1/sessions/${id2}/messages`, TOKEN, { requestId: "r2", prompt: "新任务" });
      expect(res.statusCode).toBe(202);

      // 清理
      await post(app, `/v1/sessions/${id2}/abort`, TOKEN);
      adapters.get(id2)!.finishStream();
      await flush();
    });
  });

  describe("持久化幂等（跨 runtime 重建）", () => {
    it("重建 runtime 后同 requestId 返回 done 不重复执行", async () => {
      const db = new DatabaseSync(":memory:");
      const idempotencyRepo = new SqliteIdempotencyRepository(db);

      // 第一次 app：发消息并完成
      const { app: app1 } = makeApp(
        async () => new MockAgentAdapter([{ type: "agent_end", messages: [], willRetry: false }]),
        { db, idempotencyRepo },
      );
      const id = await createSession(app1, TOKEN);
      const first = await post(app1, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "r1", prompt: "首次" });
      expect(first.statusCode).toBe(202);
      await flush();
      await flush(); // 等 fire-and-forget 幂等落库
      await app1.close();

      // 第二次 app（模拟重启）：同 requestId 命中持久化结果，不重复执行
      const { app: app2, adapters: adapters2 } = makeApp(
        async () => new MockAgentAdapter(),
        { db, idempotencyRepo },
      );
      const second = await post(app2, `/v1/sessions/${id}/messages`, TOKEN, { requestId: "r1", prompt: "重复" });
      expect(second.statusCode).toBe(200);
      expect(second.body).toEqual({ status: "completed" });

      const adapter2 = adapters2.get(id) as MockAgentAdapter;
      expect(adapter2.calls.filter((c) => c.method === "prompt")).toHaveLength(0);
      await app2.close();
    });
  });
});
