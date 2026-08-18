import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  SSE_BACKPRESSURE_THRESHOLD,
  nextBackpressureState,
} from "../../src/server/sse-backpressure.js";
import { buildApp } from "../../src/server/app.js";
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { SqliteProjectRepository } from "../../src/storage/sqlite-project-repository.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { SseSocket } from "../../src/server/sse-socket.js";
import type { UserIdentity } from "../../src/core/user-identity.js";

describe("SSE 背压判定（纯逻辑）", () => {
  it("write 成功重置背压计数", () => {
    expect(nextBackpressureState(5, true)).toEqual({ backpressure: 0, shouldClose: false });
  });

  it("write 失败累计计数", () => {
    expect(nextBackpressureState(3, false)).toEqual({ backpressure: 4, shouldClose: false });
  });

  it("连续失败超过阈值后标记应关闭", () => {
    expect(nextBackpressureState(SSE_BACKPRESSURE_THRESHOLD, false)).toEqual({
      backpressure: SSE_BACKPRESSURE_THRESHOLD + 1,
      shouldClose: true,
    });
  });

  it("阈值内不关闭，成功后可恢复", () => {
    let state = { backpressure: 0, shouldClose: false };
    for (let i = 0; i < SSE_BACKPRESSURE_THRESHOLD; i++) {
      state = nextBackpressureState(state.backpressure, false);
    }
    expect(state).toEqual({ backpressure: SSE_BACKPRESSURE_THRESHOLD, shouldClose: false });
    // 一次成功 → 归零恢复
    expect(nextBackpressureState(state.backpressure, true)).toEqual({ backpressure: 0, shouldClose: false });
  });
});

describe("SSE 背压集成（fake socket）", () => {
  const IDENTITY: UserIdentity = { kind: "ip", ip: "127.0.0.1" };

  function makeAppWithSlowSocket() {
    const db = new DatabaseSync(":memory:");
    let ended = false;
    let writeCalls = 0;
    const projects = new SqliteProjectRepository(db);
    void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/backpressure", ownerKey: "", createdAt: 0 });
    const app = buildApp({
      sessions: new SqliteSessionRepository(db),
      projects,
      defaultProjectCwd: "/tmp/backpressure",
      authenticate: async () => IDENTITY,
      // 阈值 2：连续第 3 次 write=false 触发关闭
      sseBackpressureThreshold: 2,
      sseSocketFactory: (replyRaw, requestRaw): SseSocket => ({
        writeHead: (status, headers) => replyRaw.writeHead(status, headers),
        flushHeaders: () => replyRaw.flushHeaders(),
        write: () => {
          writeCalls++;
          return false; // 模拟慢消费者：缓冲永远写满
        },
        end: () => {
          ended = true;
          replyRaw.end();
        },
        onClose: (cb) => requestRaw.on("close", cb),
      }),
      createAdapter: async () =>
        new MockAgentAdapter([
          { type: "agent_start" },
          { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } },
          { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" } },
          { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "c" } },
          { type: "agent_end", messages: [], willRetry: false },
        ]),
    });
    return { app, getEnded: () => ended, getWriteCalls: () => writeCalls };
  }

  it("write 连续失败超阈值后主动关闭连接", async () => {
    const { app, getEnded } = makeAppWithSlowSocket();

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ title: "背压" }),
    });
    const id = (created.json() as { id: string }).id;

    // 发消息：事件写入事件总线缓冲
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ requestId: "r1", prompt: "你好" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 订阅并补发：write 连续失败 → 背压超阈值 → end
    await app.inject({
      method: "GET",
      url: `/v1/sessions/${id}/events`,
      headers: { "last-event-id": "0" },
    });

    expect(getEnded()).toBe(true);
  });
});
