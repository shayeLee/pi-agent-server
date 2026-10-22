import { afterEach, describe, expect, test } from "vitest";
import { McpClient } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { SseEvent } from "../../src/client/index.js";
import { createBridge } from "../../src/claude-bridge/bridge.js";
import type { BridgeConfig } from "../../src/claude-bridge/config.js";
import { BRIDGE_TITLE_PREFIX, LIMITS } from "../../src/claude-bridge/tools.js";
import { FakePi } from "./fake-pi.js";

const clients: McpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(fake: FakePi, overrides: Partial<BridgeConfig> = {}) {
  const config: BridgeConfig = { baseUrl: "http://pi.test", token: "", label: "test", webUrl: "", waitMs: 2000, projects: [], ...overrides };
  const pair = createInMemoryTransportPair();
  await createBridge(config, fake.fetch as typeof fetch).connect(pair.server);
  const client = new McpClient({ name: "test", version: "0" });
  await client.connect(pair.client);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool(name, args);
    const text = (result.content[0] as { text: string }).text;
    return { isError: result.isError === true, text, data: result.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}

/** Runs a turn on the fake: agent start, one top-level and one nested tool call, a reply, then `end`. */
function scriptTurn(fake: FakePi, reply: string, end: (requestId: string) => SseEvent = (requestId) => ({ type: "completed", requestId })) {
  fake.onMessage = (sessionId, { requestId, prompt }) => {
    setTimeout(() => {
      fake.emit(sessionId, { type: "status", phase: "agent_start", requestId } as SseEvent);
      fake.emit(sessionId, { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {}, requestId } as SseEvent);
      fake.emit(sessionId, { type: "tool_start", toolCallId: "t2", toolName: "mcp__x", args: {}, parentToolCallId: "t1", requestId } as SseEvent);
      fake.say(sessionId, "user", prompt);
      fake.say(sessionId, "assistant", reply);
      fake.emit(sessionId, end(requestId));
    }, 5);
    return { status: 202, body: { status: "accepted" } };
  };
}

describe("protocol", () => {
  test("negotiates the client's protocol version and lists the tools", async () => {
    const { client } = await connect(new FakePi());
    expect(client.serverInfo?.name).toBe("pi-agent-server-bridge");
    const names = (await client.listTools()).map((tool) => tool.name);
    expect(names).toEqual(["pi_list_projects", "pi_list_models", "pi_list_sessions", "pi_get_session", "pi_create_session", "pi_send", "pi_wait", "pi_steer", "pi_abort"]);
  });

  test("an unknown tool is a protocol error", async () => {
    const { client } = await connect(new FakePi());
    await expect(client.callTool("pi_delete_everything", {})).rejects.toThrow(/没有这个工具/);
  });
});

describe("pi_send", () => {
  test("subscribes before submitting and returns the turn's last reply", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    scriptTurn(fake, "全部完成");
    const { call } = await connect(fake);

    const { data } = await call("pi_send", { sessionId: session.id, prompt: "跑测试" });

    expect(data).toMatchObject({ status: "completed", reply: "全部完成", toolCalls: 1, sessionId: session.id });
    expect(data.note).toBeUndefined();
    const paths = fake.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths.indexOf(`GET /v1/sessions/${session.id}/events`)).toBeLessThan(paths.indexOf(`POST /v1/sessions/${session.id}/messages`));
    expect(fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/messages"))?.body).toEqual({ requestId: data.requestId, prompt: "跑测试" });
    await expect.poll(() => fake.openStreams(session.id)).toBe(0);
  });

  test("ignores events that belong to another request", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    fake.onMessage = (sessionId, { requestId }) => {
      setTimeout(() => {
        fake.emit(sessionId, { type: "completed", requestId: "someone-else" } as SseEvent);
        fake.say(sessionId, "assistant", "mine");
        fake.emit(sessionId, { type: "completed", requestId } as SseEvent);
      }, 5);
      return { status: 202, body: { status: "accepted" } };
    };
    const { call } = await connect(fake);
    const { data } = await call("pi_send", { sessionId: session.id, prompt: "x" });
    expect(data).toMatchObject({ status: "completed", reply: "mine" });
  });

  test("returns running when the wait runs out, and pi_wait picks the result up", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    const { call } = await connect(fake, { waitMs: 30 });

    const first = await call("pi_send", { sessionId: session.id, prompt: "慢活" });
    expect(first.data).toMatchObject({ status: "running", toolCalls: 0 });
    expect(fake.openStreams(session.id)).toBe(1);

    fake.say(session.id, "assistant", "终于好了");
    fake.emit(session.id, { type: "completed", requestId: first.data.requestId } as SseEvent);
    const second = await call("pi_wait", { requestId: first.data.requestId });
    expect(second.data).toMatchObject({ status: "completed", reply: "终于好了" });
  });

  test("wait: false returns right after submitting", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    scriptTurn(fake, "later");
    const { call } = await connect(fake);
    const { data } = await call("pi_send", { sessionId: session.id, prompt: "x", wait: false });
    expect(data.status).toBe("running");
    const done = await call("pi_wait", { requestId: data.requestId });
    expect(done.data).toMatchObject({ status: "completed", reply: "later" });
  });

  test("reports a queued prompt with its position", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    fake.onMessage = () => ({ status: 202, body: { status: "queued", position: 2 } });
    const { call } = await connect(fake, { waitMs: 10 });
    const { data } = await call("pi_send", { sessionId: session.id, prompt: "x" });
    expect(data).toMatchObject({ status: "queued", queuePosition: 2 });
  });

  test("reports a failed turn with the server's message", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    scriptTurn(fake, "", (requestId) => ({ type: "error", message: "模型不可用", requestId } as SseEvent));
    const { call } = await connect(fake);
    const { data } = await call("pi_send", { sessionId: session.id, prompt: "x" });
    expect(data).toMatchObject({ status: "error", error: "模型不可用", reply: null });
  });

  test("a server restart ends the wait instead of hanging", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    fake.onMessage = () => {
      setTimeout(() => {
        fake.epoch = "epoch-2";
        fake.closeStreams(session.id);
      }, 5);
      return { status: 202, body: { status: "accepted" } };
    };
    const { call } = await connect(fake, { waitMs: 5000 });
    const { data } = await call("pi_send", { sessionId: session.id, prompt: "x" });
    expect(data.status).toBe("error");
    expect(data.error).toMatch(/重启/);
  });

  test("a rejected submit is a tool error and leaves no stream open", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    fake.onMessage = () => ({ status: 409, body: { message: "同一 requestId 不能用于不同内容" } });
    const { call } = await connect(fake);
    const result = await call("pi_send", { sessionId: session.id, prompt: "x", requestId: "r1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/提交被拒绝/);
    await expect.poll(() => fake.openStreams(session.id)).toBe(0);
  });

  test("warns when the session was not created by the bridge", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: "我自己的会话" });
    scriptTurn(fake, "ok");
    const { call } = await connect(fake);
    const { data } = await call("pi_send", { sessionId: session.id, prompt: "x" });
    expect(data.note).toMatch(/不是桥接建的/);
  });

  test("clips a long reply", async () => {
    const fake = new FakePi();
    const session = fake.addSession({ title: `${BRIDGE_TITLE_PREFIX}task` });
    const long = "长".repeat(LIMITS.reply + 10);
    scriptTurn(fake, long);
    const { call } = await connect(fake);
    const { data } = await call("pi_send", { sessionId: session.id, prompt: "x" });
    expect(data.reply.startsWith("长".repeat(LIMITS.reply))).toBe(true);
    expect(data.reply).toMatch(new RegExp(`原文共 ${long.length} 字`));
  });

  test("pi_wait for a request the bridge never sent is a tool error", async () => {
    const { call } = await connect(new FakePi());
    const result = await call("pi_wait", { requestId: "nope" });
    expect(result.isError).toBe(true);
  });
});

describe("sessions", () => {
  test("pi_create_session prefixes the title and applies the model and thinking level", async () => {
    const fake = new FakePi();
    const { call } = await connect(fake, { webUrl: "http://web.test" });
    const { data } = await call("pi_create_session", { title: "整理文档", projectId: "p2", model: "openai/gpt-6-luna", thinkingLevel: "low" });
    expect(data).toMatchObject({ title: `${BRIDGE_TITLE_PREFIX}整理文档`, projectId: "p2", model: "openai/gpt-6-luna", thinkingLevel: "low" });
    expect(data.webUrl).toBe(`http://web.test/p/p2/s/${data.id}`);
  });

  test("pi_create_session rejects an unknown model before creating anything", async () => {
    const fake = new FakePi();
    const { call } = await connect(fake);
    const result = await call("pi_create_session", { title: "x", model: "nobody/none" });
    expect(result.isError).toBe(true);
    expect(fake.sessions).toHaveLength(0);
  });

  test("write tools refuse when the backend grants no write access", async () => {
    const fake = new FakePi();
    fake.access = { canRead: true, canWrite: false };
    const { call } = await connect(fake);
    const result = await call("pi_create_session", { title: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/没有写权限/);
  });

  test("PI_BRIDGE_PROJECTS hides other projects and their sessions", async () => {
    const fake = new FakePi();
    fake.addSession({ projectId: "p1" });
    const outside = fake.addSession({ projectId: "p2" });
    const { call } = await connect(fake, { projects: ["p1"] });
    expect((await call("pi_list_projects")).data.map((p: { id: string }) => p.id)).toEqual(["p1"]);
    expect((await call("pi_list_sessions")).data.map((s: { projectId: string }) => s.projectId)).toEqual(["p1"]);
    expect((await call("pi_send", { sessionId: outside.id, prompt: "x" })).isError).toBe(true);
    expect((await call("pi_create_session", { title: "x" })).isError).toBe(true);
  });

  test("pi_get_session returns the last messages with tool calls in between", async () => {
    const fake = new FakePi();
    const session = fake.addSession();
    for (let i = 0; i < LIMITS.defaultTail + 2; i++) fake.say(session.id, i % 2 ? "assistant" : "user", `第 ${i} 条`);
    fake.timelines.get(session.id)!.push({
      id: "tc", type: "tool_call", messageId: "m", turnId: null, callId: "tc", toolCallId: "tc", toolName: "bash", args: { cmd: "ls" }, status: "completed", order: 99,
    });
    const { call } = await connect(fake);
    const { data } = await call("pi_get_session", { sessionId: session.id });
    const messages = data.entries.filter((e: { role?: string }) => e.role);
    expect(messages).toHaveLength(LIMITS.defaultTail);
    expect(data.omittedMessages).toBe(data.totalMessages - LIMITS.defaultTail);
    expect(data.entries.at(-1)).toEqual({ tool: "bash", status: "completed" });
    const withTools = await call("pi_get_session", { sessionId: session.id, includeTools: true });
    expect(withTools.data.entries.at(-1).args).toBe(JSON.stringify({ cmd: "ls" }));
  });
});

describe("control", () => {
  test("pi_abort sends the request id and explains a 409", async () => {
    const fake = new FakePi();
    const session = fake.addSession();
    const { call } = await connect(fake);
    expect((await call("pi_abort", { sessionId: session.id, requestId: "r1" })).data.status).toBe("abort_requested");
    expect(fake.calls.at(-1)?.body).toEqual({ requestId: "r1" });

    fake.onAbort = () => ({ status: 409 });
    const conflict = await call("pi_abort", { sessionId: session.id, requestId: "r1" });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/没有中止任何任务/);
  });

  test("pi_steer explains when nothing is running", async () => {
    const fake = new FakePi();
    const session = fake.addSession();
    fake.onSteer = () => ({ status: 409 });
    const { call } = await connect(fake);
    const result = await call("pi_steer", { sessionId: session.id, text: "换个思路" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/没有正在运行的任务/);
  });
});
