import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { formatSseEvent } from "../../src/server/sse-format.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { identityKey } from "../../src/core/user-identity.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";

// WP5D-2：真实 TCP 连接来自 127.0.0.1；策略登记 127.0.0.1 为 tokenRequired（Bearer token-1）。
const TOKEN = "token-1";
const JSON_HEADERS = { "content-type": "application/json" };
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SSE 帧格式化（needs.md §4.2）", () => {
  it("按传入 id 生成带 data 的 SSE 帧", () => {
    expect(formatSseEvent(3, { type: "text_delta", text: "hi" })).toBe(
      'id: 3\ndata: {"type":"text_delta","text":"hi"}\n\n',
    );
  });
});

describe("WP5D-3 P2：SSE 关闭/配额检查先于任何 runtime 创建（零副作用）", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  });

  /** 预置一个 127.0.0.1 所属会话（绕过 HTTP 创建）。 */
  async function seedSession(sessions: Awaited<ReturnType<typeof makeInitializedMemoryDb>>["sessions"], id: string): Promise<void> {
    await sessions.create({
      id,
      ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }),
      projectId: DEFAULT_PROJECT_ID,
      title: "配额测试",
      createdAt: 1,
      updatedAt: 1,
      piSessionFile: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      systemPrompt: null,
      capabilityVersions: null,
    });
  }

  it("配额超限 429：在 runtime 创建之前拒绝，createAdapter 0、DB 不变（含不存在会话）", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(sessions, "quota-session");
    let created = 0;
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: "127.0.0.1", tokenRequired: true, tokens: [TOKEN] }]),
      }),
      maxSsePerUser: 0,
      maxSseGlobal: 0,
      createAdapter: async () => {
        created++;
        return new MockAgentAdapter();
      },
    });
    apps.push(app);

    const before = await sessions.get("quota-session");
    for (const url of ["/v1/sessions/quota-session/events", "/v1/sessions/no-such/events"]) {
      const res = await app.inject({
        method: "GET",
        url,
        remoteAddress: "127.0.0.1",
        headers: authHeader(TOKEN),
      });
      expect(res.statusCode, url).toBe(429);
      expect(res.json()).toMatchObject({ statusCode: 429, error: "Too Many Requests" });
    }
    expect(created).toBe(0); // 零 createAdapter 副作用
    expect(await sessions.get("quota-session")).toEqual(before); // DB 逐字段不变
  });

  it("关闭中 503：真实连接在 preClose 期间被拒，createAdapter 0、DB 不变", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(sessions, "closing-session");
    let created = 0;
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: "127.0.0.1", tokenRequired: true, tokens: [TOKEN] }]),
      }),
      createAdapter: async () => {
        created++;
        return new MockAgentAdapter();
      },
    });
    // 在 preClose 挂起（closing=true）窗口内发起真实请求：buildApp 内建 preClose 先置
    // closing，随后注册的 hook 等待 gate——此窗口监听器仍接受连接，SSE 路由必须先拒 503。
    // 必须先于 listen 注册（Fastify listen 后禁止 addHook）。
    let releaseClose: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    app.addHook("preClose", async () => {
      await gate;
    });
    await app.listen({ port: 0 });
    apps.push(app);
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const closePromise = app.close(); // 进入 preClose：closing=true，随后阻塞在 gate 上
    await flush(); // 等待内建 preClose（closing=true）执行完

    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/closing-session/events`, {
      headers: authHeader(TOKEN),
    });
    expect(res.status).toBe(503);
    await res.text(); // 消费响应体

    releaseClose();
    await closePromise;
    expect(created).toBe(0); // 零 createAdapter 副作用
    expect((await sessions.get("closing-session"))?.title).toBe("配额测试"); // DB 不变
  });
});

describe("GET /v1/sessions/:id/events（SSE 订阅与 Last-Event-ID 补发）", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  });

  async function makeListeningApp(serverEpoch?: string) {
    const { projects, sessions } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      // 准入：127.0.0.1 登记为 tokenRequired（真实 SSE 连接必须携带 Bearer token-1）
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: "127.0.0.1", tokenRequired: true, tokens: [TOKEN] }]),
      }),
      serverEpoch,
      createAdapter: async () =>
        new MockAgentAdapter([
          { type: "agent_start" },
          {
            type: "message_update",
            message: {},
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" },
          },
          { type: "agent_end", messages: [], willRetry: false },
        ]),
    });
    await app.listen({ port: 0 });
    apps.push(app);
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { app, port };
  }

  async function createSession(app: FastifyInstance): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...authHeader(TOKEN), ...JSON_HEADERS }, remoteAddress: "127.0.0.1",
      payload: JSON.stringify({ title: "SSE 会话" }),
    });
    return res.json().id;
  }

  /** 读 SSE 流直到 predicate 满足或超时（AbortController 终止）。lastEventId 可选：不传只收新事件，传 0 从头补发。 */
  async function readSseUntil(
    url: string,
    predicate: (text: string) => boolean,
    opts: { timeoutMs?: number; lastEventId?: number; clientEpoch?: string } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 3000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...authHeader(TOKEN) };
    if (opts.lastEventId !== undefined) headers["last-event-id"] = String(opts.lastEventId);
    if (opts.clientEpoch !== undefined) headers["x-client-epoch"] = opts.clientEpoch;
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (predicate(text)) break;
      }
    } catch (error) {
      // 仅忽略超时中断（AbortError）；连接错误等应让测试失败而非假通过
      if ((error as Error)?.name !== "AbortError") throw error;
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
    return text;
  }

  it("订阅前已产生的事件按 Last-Event-ID 补发", async () => {
    const { app, port } = await makeListeningApp();
    const id = await createSession(app);

    // 触发一次流式：agent_start → text_delta → completed 写入事件总线
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: { ...authHeader(TOKEN), ...JSON_HEADERS }, remoteAddress: "127.0.0.1",
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await flush(); // 等待后台流式完成

    const text = await readSseUntil(
      `http://127.0.0.1:${port}/v1/sessions/${id}/events`,
      (t) => t.includes("completed"),
      { lastEventId: 0 },
    );
    expect(text).toContain('data: {"type":"status","phase":"agent_start","requestId":"r1"}');
    expect(text).toContain('data: {"type":"text_delta","text":"你好"}');
    expect(text).toContain('data: {"type":"completed"}');
    // 事件带递增 id
    expect(text).toMatch(/^id: 1\ndata: /);
  });

  it("无鉴权访问 events 返回 401", async () => {
    const { app, port } = await makeListeningApp();
    const id = await createSession(app);
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${id}/events`);
    expect(res.status).toBe(401);
  });

  it("epoch 不匹配（服务重启）时忽略旧 cursor 从头补发", async () => {
    const { app, port } = await makeListeningApp("epoch-A");
    const id = await createSession(app);
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: { ...authHeader(TOKEN), ...JSON_HEADERS }, remoteAddress: "127.0.0.1",
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await flush();

    // 客户端持有旧 epoch + 旧大 cursor（如 999）；服务端应忽略旧 cursor 从头补发
    const text = await readSseUntil(
      `http://127.0.0.1:${port}/v1/sessions/${id}/events`,
      (t) => t.includes("completed"),
      { lastEventId: 999, clientEpoch: "epoch-OLD" },
    );
    expect(text).toMatch(/^id: 1\ndata: /); // 从头补发
    expect(text).toContain('data: {"type":"text_delta","text":"你好"}');
    expect(text).toContain('data: {"type":"completed"}');
  });

  it("先订阅后实时收到新事件（不补发历史）", async () => {
    const { app, port } = await makeListeningApp();
    const id = await createSession(app);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${id}/events`, {
      headers: { ...authHeader(TOKEN) },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // 连接建立后触发消息（实时事件应推送到已订阅的连接）
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: { ...authHeader(TOKEN), ...JSON_HEADERS }, remoteAddress: "127.0.0.1",
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });

    let text = "";
    while (!text.includes("completed")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    clearTimeout(timer);
    reader.cancel().catch(() => {});

    expect(text).toContain('data: {"type":"text_delta","text":"你好"}');
    expect(text).toContain('data: {"type":"completed"}');
  });

  it("epoch 匹配时按 cursor 续传（不从头）", async () => {
    const { app, port } = await makeListeningApp("epoch-A");
    const id = await createSession(app);
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: { ...authHeader(TOKEN), ...JSON_HEADERS }, remoteAddress: "127.0.0.1",
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await flush();

    // 客户端持有匹配 epoch + cursor=1；服务端应从 id>1 补发（不含 id:1 的 agent_start）
    const text = await readSseUntil(
      `http://127.0.0.1:${port}/v1/sessions/${id}/events`,
      (t) => t.includes("completed"),
      { lastEventId: 1, clientEpoch: "epoch-A" },
    );
    expect(text).toMatch(/^id: 2\ndata: /); // 从 id 2 续传
    expect(text).not.toContain('"phase":"agent_start"');
    expect(text).toContain('data: {"type":"completed"}');
  });
});
