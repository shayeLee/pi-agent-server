import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess, USER_IP_B } from "../helpers/ip-access.js";
import type { ActivitySnapshot, ActivityStreamMessage } from "../../src/shared/activity.js";

// docs/companion-butler.md §4.2: runs across every session the caller can see, and only those.
const ME = "127.0.0.1";
const JSON_HEADERS = { "content-type": "application/json" };

/** Fails its turn when the prompt says so; otherwise ends normally. */
class Adapter extends MockAgentAdapter {
  override async prompt(text: string): Promise<void> {
    if (text === "fail") throw new Error("模型调用失败\n内部细节");
    this.enqueue({ type: "agent_end", messages: [], willRetry: false });
    await super.prompt(text);
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close().catch(() => {}))); });

async function makeApp(): Promise<FastifyInstance> {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const app = buildApp({ sessions, projects, defaultProjectCwd: "/tmp/default-project", ipAccess: makeTestIpAccess(),
    createAdapter: async () => new Adapter() });
  apps.push(app);
  return app;
}

async function createSession(app: FastifyInstance, ip: string, title: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/sessions", headers: JSON_HEADERS, remoteAddress: ip, payload: JSON.stringify({ title }) });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function send(app: FastifyInstance, ip: string, id: string, prompt: string): Promise<void> {
  const res = await app.inject({ method: "POST", url: `/v1/sessions/${id}/messages`, headers: JSON_HEADERS, remoteAddress: ip,
    payload: JSON.stringify({ requestId: `r-${prompt}-${Math.random()}`, prompt }) });
  expect(res.statusCode).toBe(202);
}

async function activity(app: FastifyInstance, ip: string): Promise<ActivitySnapshot> {
  const res = await app.inject({ method: "GET", url: "/v1/activity", remoteAddress: ip });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

/** Reads SSE messages from a real connection until `enough` says stop. */
async function readStream(url: string, enough: (messages: ActivityStreamMessage[]) => boolean, onOpen?: () => Promise<void>) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: ActivityStreamMessage[] = [];
  let buffer = "";
  let opened = false;
  try {
    while (!enough(messages)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (data) messages.push(JSON.parse(data.slice(6)));
      }
      if (!opened && messages.length > 0) { opened = true; await onOpen?.(); }
    }
  } finally {
    controller.abort();
  }
  return messages;
}

describe("GET /v1/activity", () => {
  it("lists the caller's running and finished runs, with titles and a one-line error, and nobody else's", async () => {
    const app = await makeApp();
    const mine = await createSession(app, ME, "我的会话");
    const theirs = await createSession(app, USER_IP_B, "别人的会话");
    expect(await activity(app, ME)).toEqual({ running: [], recent: [] });

    await send(app, ME, mine, "hello");
    await send(app, USER_IP_B, theirs, "hello");
    const done = await until(() => activity(app, ME), value => value.recent.length === 1);
    expect(done.running).toEqual([]);
    expect(done.recent).toEqual([expect.objectContaining({ sessionId: mine, title: "我的会话", kind: "completed" })]);

    await send(app, ME, mine, "fail");
    const failed = await until(() => activity(app, ME), value => value.recent.length === 2);
    expect(failed.recent[0]).toMatchObject({ sessionId: mine, kind: "failed", message: "模型调用失败" });

    const other = await activity(app, USER_IP_B);
    expect(other.recent.map(result => result.sessionId)).toEqual([theirs]);
  });

  it("a deleted session drops out", async () => {
    const app = await makeApp();
    const id = await createSession(app, ME, "会删掉");
    await send(app, ME, id, "hello");
    await until(() => activity(app, ME), value => value.recent.length === 1);
    expect((await app.inject({ method: "DELETE", url: `/v1/sessions/${id}`, remoteAddress: ME })).statusCode).toBe(204);
    expect(await activity(app, ME)).toEqual({ running: [], recent: [] });
  });
});

describe("GET /v1/activity/events", () => {
  it("starts with a snapshot, then sends the caller's changes only", async () => {
    const app = await makeApp();
    const earlier = await createSession(app, ME, "之前的会话");
    await send(app, ME, earlier, "hello");
    await until(() => activity(app, ME), value => value.recent.length === 1);
    const mine = await createSession(app, ME, "现在的会话");
    const theirs = await createSession(app, USER_IP_B, "别人的会话");
    await app.listen({ port: 0, host: ME });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const messages = await readStream(`http://${ME}:${port}/v1/activity/events`,
      seen => seen.some(message => message.type === "activity" && message.event.kind === "completed"),
      async () => {
        await send(app, USER_IP_B, theirs, "hello");
        await send(app, ME, mine, "hello");
      });

    expect(messages[0]).toMatchObject({ type: "activity_snapshot", running: [], recent: [expect.objectContaining({ sessionId: earlier })] });
    const changes = messages.slice(1).map(message => message.type === "activity" ? [message.event.sessionId, message.event.kind, message.event.title] : null);
    expect(changes).toEqual([[mine, "started", "现在的会话"], [mine, "completed", "现在的会话"]]);
  });
});
