import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentAdapter } from "../../src/agent/agent-adapter.js";
import type { SessionHistoryReader } from "../../src/application/ports/index.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

// WP5D-2：身份 = 来源 IP
const TOKEN = "10.0.0.1";
const OTHER_TOKEN = "10.0.0.2";

async function makeApp(options: {
  createAdapter?: (sessionId: string) => Promise<AgentAdapter>;
  sessionHistoryReader?: SessionHistoryReader;
} = {}): Promise<{
  app: FastifyInstance;
  adapters: Map<string, AgentAdapter>;
}> {
  const { projects, sessions } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const adapters = new Map<string, AgentAdapter>();
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    ipAccess: makeTestIpAccess(),
    sessionHistoryReader: options.sessionHistoryReader,
    createAdapter: async (sessionId) => {
      const adapter = await (options.createAdapter ?? (async () => new MockAgentAdapter()))(sessionId);
      adapters.set(sessionId, adapter);
      return adapter;
    },
  });
  return { app, adapters };
}

const JSON_HEADERS = { "content-type": "application/json" };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function createSession(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: JSON_HEADERS, remoteAddress: token,
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
    remoteAddress: token,
  });
  return { statusCode: res.statusCode, body: res.body ? res.json() : undefined };
}

/** 真实生产形态的 JSONL 会话文件（v3 头 + user/assistant/toolResult 消息）。 */
function makeJsonlFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-export-fixture-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(
    file,
    [
      '{"type":"session","version":3,"id":"sess-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}',
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"},{"type":"thinking","text":"思考"}]}}',
      '{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"工具"}]}}',
      "",
    ].join("\n"),
  );
  return file;
}

function fileFingerprint(file: string): string {
  const st = statSync(file);
  return JSON.stringify({
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  });
}

describe("HTTP 层：会话导出（GET /v1/sessions/:id/export）", () => {
  it("runtime 已实例化（发过消息）：导出活会话数据与事件游标", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const { app } = await makeApp({
      createAdapter: async () => {
        const adapter = new MockAgentAdapter();
        adapter.exportData = messages;
        return adapter;
      },
    });
    const id = await createSession(app, TOKEN);

    // 发消息 → runtime 实例化（首次也是唯一一次 createAdapter）
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: JSON_HEADERS, remoteAddress: TOKEN,
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await flush();

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);

    expect(res.statusCode).toBe(200);
    expect((res.body as { messages: unknown }).messages).toEqual(messages);
    expect((res.body as { lastEventId: number }).lastEventId).toBeGreaterThan(0);
  });

  it("未发送过消息的会话导出默认返回空消息列表", async () => {
    const { app } = await makeApp();
    const id = await createSession(app, TOKEN);

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ messages: [], lastEventId: 0 });
  });

  it("发消息后导出：lastEventId 非零（事件游标随事件写入递增）", async () => {
    const { app } = await makeApp({
      createAdapter: async () => new MockAgentAdapter([
        { type: "agent_start" },
        { type: "agent_end", messages: [], willRetry: false },
      ]),
    });
    const id = await createSession(app, TOKEN);

    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: JSON_HEADERS, remoteAddress: TOKEN,
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await flush(); // 等待后台流式完成

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);
    expect(res.statusCode).toBe(200);
    expect((res.body as { lastEventId: number }).lastEventId).toBeGreaterThan(0);
  });

  it("持久化但未实例化（piSessionFile 有值、无 runtime）：注入 reader 只读解析，createAdapter 0 且文件指纹不变", async () => {
    const fixture = makeJsonlFixture();
    const calls: string[] = [];
    const reader: SessionHistoryReader = {
      async readSessionHistory(piSessionFile: string): Promise<unknown> {
        calls.push(piSessionFile);
        // 生产实现行为（tests/server/session-history-reader.test.ts 覆盖真实 SDK 解析）；
        // 这里用与 PiAgentAdapter 同一投影的固定返回模拟其输出契约。
        return [
          { role: "user", text: "hi" },
          { role: "assistant", text: "hello" },
        ];
      },
    };
    const { app, sessions, adapters } = await makeAppWithPersistedSession(fixture, reader);

    const before = fileFingerprint(fixture);
    const res = await get(app, `/v1/sessions/persisted/export`, TOKEN);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      lastEventId: 0, // 未实例化：无事件游标
    });
    expect(calls).toEqual([fixture]); // 只读解析口被精确调用
    expect(adapters.size).toBe(0); // 零 createAdapter 副作用
    expect(await sessions.get("persisted")).toMatchObject({ id: "persisted", piSessionFile: fixture });
    expect(fileFingerprint(fixture)).toBe(before); // piSessionFile 逐字节不变
  });

  it("持久化但未实例化且注入的 reader 抛错：500 脱敏（不含路径），createAdapter 0", async () => {
    const fixture = makeJsonlFixture();
    const reader: SessionHistoryReader = {
      async readSessionHistory(): Promise<unknown> {
        throw new Error("internal parse detail: /secret/path/leak");
      },
    };
    const { app, adapters } = await makeAppWithPersistedSession(fixture, reader);

    const res = await get(app, `/v1/sessions/persisted/export`, TOKEN);

    expect(res.statusCode).toBe(500);
    const message = JSON.stringify(res.body);
    expect(message).not.toContain("leak");
    expect(message).not.toContain(fixture);
    expect(adapters.size).toBe(0);
  });

  it("持久化但未注入 reader：failclosed 500 脱敏（绝不回退 createAdapter），createAdapter 0", async () => {
    const fixture = makeJsonlFixture();
    const { app, sessions, adapters } = await makeAppWithPersistedSession(fixture, undefined);

    const res = await get(app, `/v1/sessions/persisted/export`, TOKEN);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).toContain("会话历史只读解析不可用");
    expect(adapters.size).toBe(0);
    expect((await sessions.get("persisted"))?.piSessionFile).toBe(fixture);
  });

  it("已有 runtime 的持久化会话：活会话导出优先，reader 不被调用", async () => {
    const fixture = makeJsonlFixture();
    const readerCalls: string[] = [];
    const reader: SessionHistoryReader = {
      async readSessionHistory(piSessionFile: string): Promise<unknown> {
        readerCalls.push(piSessionFile);
        return [];
      },
    };
    const liveMessages = [
      { role: "user", content: [{ type: "text", text: "live-hi" }] },
      { role: "assistant", content: [{ type: "text", text: "live-hello" }] },
    ];
    const { app, sessions } = await makeAppWithPersistedSession(fixture, reader, liveMessages);

    // 发消息实例化 runtime，随后把 piSessionFile 写入记录（模拟已持久化的活跃会话）
    await app.inject({
      method: "POST",
      url: `/v1/sessions/persisted/messages`,
      headers: JSON_HEADERS, remoteAddress: TOKEN,
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await flush();
    await sessions.update("persisted", { piSessionFile: fixture });

    const res = await get(app, `/v1/sessions/persisted/export`, TOKEN);

    expect(res.statusCode).toBe(200);
    expect((res.body as { messages: unknown }).messages).toEqual(liveMessages);
    expect((res.body as { lastEventId: number }).lastEventId).toBeGreaterThan(0);
    expect(readerCalls).toEqual([]); // 活会话导出不触达只读解析口
  });

  it("他人的会话导出返回 404（越权不可见）", async () => {
    const { app } = await makeApp();
    const id = await createSession(app, OTHER_TOKEN);

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);

    expect(res.statusCode).toBe(404);
  });

  it("不存在的会话导出返回 404", async () => {
    const { app } = await makeApp();

    const res = await get(app, "/v1/sessions/no-such/export", TOKEN);

    expect(res.statusCode).toBe(404);
  });

  it("token off 默认画像：不携带任何 token 也可导出（身份 = 默认来源 IP）", async () => {
    const { app } = await makeApp();
    const id = await createSession(app, TOKEN);

    const res = await get(app, `/v1/sessions/${id}/export`, TOKEN);

    expect(res.statusCode).toBe(200);
  });
});

/** 直接经 repository 预置持久化会话（piSessionFile 指向真实 JSONL fixture），返回 app/仓储/adapters。 */
async function makeAppWithPersistedSession(
  fixture: string,
  reader: SessionHistoryReader | undefined,
  liveAdapterData?: unknown[],
): Promise<{
  app: FastifyInstance;
  sessions: Awaited<ReturnType<typeof makeInitializedMemoryDb>>["sessions"];
  adapters: Map<string, AgentAdapter>;
}> {
  const { projects, sessions } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  await sessions.create({
    id: "persisted",
    ownerKey: identityKey({ kind: "ip", ip: TOKEN }),
    projectId: DEFAULT_PROJECT_ID,
    title: "持久化",
    createdAt: 1,
    updatedAt: 1,
    piSessionFile: fixture,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
  });
  const adapters = new Map<string, AgentAdapter>();
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    ipAccess: makeTestIpAccess(),
    sessionHistoryReader: reader,
    createAdapter: async (sessionId) => {
      const adapter = new MockAgentAdapter();
      if (liveAdapterData) adapter.exportData = liveAdapterData;
      adapters.set(sessionId, adapter);
      return adapter;
    },
  });
  return { app, sessions, adapters };
}