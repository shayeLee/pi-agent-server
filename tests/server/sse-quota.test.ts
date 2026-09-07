// WP5D-3 P1：SSE 配额检查+占位同步原子性（首个 await 前）与占位释放恰一次。
//
// 冻结语义（src/server/app.ts 路由实现）：
// - 关闭（503）与配额（429）检查 + 占位（sseConnections += 1）必须在任何 runtime 创建/查询
//   之前于同一同步块完成——Node 单线程事件循环下检查与占位之间不可能插入其他请求的处理，
//   并发请求无法在检查后、占位前挤入，上限不可绕过；
// - 占位后任何 pre-stream 失败（404/204/查询异常/socket 工厂失败）必须恰释放一次；成功连接
//   由连接清理（cleanup，幂等）恰释放一次；global/per-user 计数正确、不泄漏。
//
// 本文件全部使用**真实 TCP 连接**（app.listen + fetch）驱动，不用 inject：并发/断连/配额
// 计数必须以真实 socket 生命周期验证。

import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { identityKey } from "../../src/core/user-identity.js";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import { buildApp } from "../../src/server/app.js";
import { defaultSseSocket } from "../../src/server/sse-socket.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import type { SessionRecord, SessionStorePort } from "../../src/application/ports/index.js";

const USER_IP = "127.0.0.1";
const TOKEN = "token-1";
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });
const owner = identityKey({ kind: "ip", ip: USER_IP });

function seedSession(sessions: SessionStorePort, id: string): Promise<void> {
  return sessions.create({
    id,
    ownerKey: owner,
    projectId: DEFAULT_PROJECT_ID,
    title: "配额并发",
    createdAt: 1,
    updatedAt: 1,
    agentKind: "pi",
    conversationFormat: "pi-jsonl-v3",
    conversationRef: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
  });
}

/** 基于某个 store 构造可覆写 get 的委托 store（其余方法一律透传）。 */
function makeStore(
  inner: SessionStorePort,
  overrides: { get?: (id: string) => Promise<SessionRecord | null> } = {},
): SessionStorePort {
  return {
    create: (record) => inner.create(record),
    get: overrides.get ?? ((id) => inner.get(id)),
    listByOwner: (o) => inner.listByOwner(o),
    listByProject: (o, p) => inner.listByProject(o, p),
    backfillSystemPrompt: (s) => inner.backfillSystemPrompt(s),
    update: (id, patch) => inner.update(id, patch),
    reserveConversation: (id, reservation) => inner.reserveConversation(id, reservation),
    commitConversationReservation: (id, expectedRef, actualRef) => inner.commitConversationReservation(id, expectedRef, actualRef),
    releaseConversationReservation: (id, expectedRef) => inner.releaseConversationReservation(id, expectedRef),
    delete: (id) => inner.delete(id),
  };
}

/** barrier：进入 store.get 的请求全部堵在 gate 上，直到 release()（并发窗口内的确定性拦截点）。 */
function makeBarrierStore(inner: SessionStorePort): {
  store: SessionStorePort;
  arrivals: () => number;
  release: () => void;
} {
  let arrivals = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const store = makeStore(inner, {
    get: async (id) => {
      arrivals++;
      await gate;
      return inner.get(id);
    },
  });
  return { store, arrivals: () => arrivals, release: () => releaseGate() };
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return port;
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 关闭一个已建立的 SSE 流（cancel + abort 双保险）；不等待服务端清理完成。 */
async function closeStream(response: Response, controller: AbortController): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* 忽略：流已不可用 */
  }
  if (!controller.signal.aborted) controller.abort();
}

/**
 * 轮询连接直到 200：证明「断开后占位已被恰释放、后续连接可正常建立」。
 * 若占位泄漏，所有探测将持续 429 直到超时失败。
 */
async function expectReopenable(port: number, urlPath: string): Promise<{ response: Response; controller: AbortController }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      headers: authHeader(TOKEN),
      signal: controller.signal,
    });
    if (res.status === 200) return { response: res, controller };
    // 占位尚未释放（服务端 close 事件处理中）：短暂窗口内的 429 可接受，继续探测
    expect(res.status).toBe(429);
    await res.text();
    if (Date.now() > deadline) throw new Error("配额未释放：断开后后续连接持续 429");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * 用不存在的会话探测配额槽位：429 表示服务端 close 清理尚未完成，继续等待；
 * 槽位可用时必须得到 404，而该探测请求会同步释放自己占用的槽位。
 */
async function expectQuotaSlotAvailable(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/no-such/events`, {
      headers: authHeader(TOKEN),
    });
    if (res.status === 404) {
      await res.text();
      return;
    }
    expect(res.status).toBe(429);
    await res.text();
    if (Date.now() > deadline) throw new Error("配额未释放：槽位探测持续 429");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("WP5D-3 P1：SSE 配额检查+占位同步原子（首个 await 前，并发不可绕）", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  });

  it("barrier 并发真实连接：6 并发仅 1 个进入 store 查询、仅 1 个 200，其余 429；断开后可再次连接", async () => {
    const { sessions: inner, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(inner, "race");
    const { store, arrivals, release } = makeBarrierStore(inner);
    let adapterCreated = 0;
    const app = buildApp({
      sessions: store,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: USER_IP, tokenRequired: true, tokens: [TOKEN] }]),
      }),
      maxSsePerUser: 1,
      maxSseGlobal: 1,
      createAdapter: async () => {
        adapterCreated++;
        return new MockAgentAdapter();
      },
    });
    apps.push(app);
    const port = await listen(app);
    const url = `http://127.0.0.1:${port}/v1/sessions/race/events`;

    const attempts = Array.from({ length: 6 }, () => {
      const controller = new AbortController();
      const promise = fetch(url, { headers: authHeader(TOKEN), signal: controller.signal });
      return { controller, promise };
    });
    // 占位成功者被 barrier 拦在 store 查询上：其余 5 个在查询之前即 429（检查+占位同步完成）。
    // 回归（检查与占位之间存在 await 间隙）时全部 6 个都会先过检查并堵在 barrier 上 →
    // settled 到不了 5 → 超时失败，证明上限不可绕过。
    const settled: Response[] = [];
    for (const { promise } of attempts) {
      promise.then((res) => settled.push(res)).catch(() => {});
    }
    await waitUntil(() => settled.length === 5);
    expect(arrivals()).toBe(1); // 只有占位成功的请求能进入 store 查询
    for (const res of settled) {
      expect(res.status).toBe(429);
    }
    release(); // 放行唯一占位者：完成查询并建立流（200）
    const all = await Promise.all(attempts.map((a) => a.promise));
    const winnerIndex = all.findIndex((res) => res.status === 200);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(all.filter((res) => res.status === 429)).toHaveLength(5);
    expect(adapterCreated).toBe(1); // 429 拒绝路径零 runtime 创建

    // 流持有期间：新连接仍被同一上限拒绝（计数保持 1，未因并发多占/少占）。
    const blocked = await fetch(url, { headers: authHeader(TOKEN) });
    expect(blocked.status).toBe(429);
    await blocked.text();

    // 断开成功流：cleanup 恰释放一次 → 后续真实连接可再次建立（计数不泄漏）。
    await closeStream(all[winnerIndex]!, attempts[winnerIndex]!.controller);
    const reopened = await expectReopenable(port, "/v1/sessions/race/events");
    await closeStream(reopened.response, reopened.controller);
  });

  it("global 上限独立于 per-user：真实连接计数正确，断开后全局槽位释放", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(sessions, "g1");
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: USER_IP, tokenRequired: true, tokens: [TOKEN] }]),
      }),
      maxSsePerUser: 4, // per-user 未到上限：全局上限先满
      maxSseGlobal: 1,
      createAdapter: async () => new MockAgentAdapter(),
    });
    apps.push(app);
    const port = await listen(app);
    const url = `http://127.0.0.1:${port}/v1/sessions/g1/events`;

    const first = new AbortController();
    const r1 = await fetch(url, { headers: authHeader(TOKEN), signal: first.signal });
    expect(r1.status).toBe(200); // 全局 1/1

    const r2 = await fetch(url, { headers: authHeader(TOKEN) });
    expect(r2.status).toBe(429); // per-user(4) 未满也因全局 1/1 拒绝
    await r2.text();

    await closeStream(r1, first);
    const reopened = await expectReopenable(port, "/v1/sessions/g1/events");
    await closeStream(reopened.response, reopened.controller);
  });

  it("viewer 204（无 live runtime）恰释放占位：后续真实连接可正常建立", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(sessions, "no-runtime-session");
    await seedSession(sessions, "live-session");
    // 预置 live-session 的 runtime（注入共享 registry；与 route-rbac 测试同一模式）。
    const registry = new RuntimeRegistry({
      concurrency: new ConcurrencyController({
        globalLimit: 20, perUserLimit: 2, perUserQueueLimit: 10, globalQueueLimit: 100, queueTimeoutMs: 300_000,
      }),
      createAdapter: async () => new MockAgentAdapter(),
    });
    await registry.getOrCreate("live-session", owner);
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: USER_IP, role: "viewer", tokenRequired: true, tokens: [TOKEN] }]),
      }),
      registry,
      maxSsePerUser: 1,
      maxSseGlobal: 100,
      createAdapter: async () => new MockAgentAdapter(),
    });
    apps.push(app);
    const port = await listen(app);

    // 1) 无 runtime → 204：占位必须释放（否则第 2 步会 429）。
    const noRuntime = await fetch(`http://127.0.0.1:${port}/v1/sessions/no-runtime-session/events`, {
      headers: authHeader(TOKEN),
    });
    expect(noRuntime.status).toBe(204);
    await noRuntime.text();

    // 2) 已有 runtime → 200：证明 204 未泄漏占位。
    const live = await expectReopenable(port, "/v1/sessions/live-session/events");

    // 3) 成功流持有期间 → 429（计数正确）。
    const blocked = await fetch(`http://127.0.0.1:${port}/v1/sessions/live-session/events`, {
      headers: authHeader(TOKEN),
    });
    expect(blocked.status).toBe(429);
    await blocked.text();

    // 4) 断开成功流 → 再次可连接（cleanup 恰一次）。
    await closeStream(live.response, live.controller);
    const reopened = await expectReopenable(port, "/v1/sessions/live-session/events");
    await closeStream(reopened.response, reopened.controller);
  });

  it("404（不存在/越权）与查询异常都恰释放占位：后续真实连接可正常建立", async () => {
    const { sessions: inner, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(inner, "stable");
    let throwOnBoom = true;
    const store = makeStore(inner, {
      get: async (id) => {
        if (throwOnBoom && id === "boom") {
          throwOnBoom = false;
          throw new Error("store-boom");
        }
        return inner.get(id);
      },
    });
    const app = buildApp({
      sessions: store,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: USER_IP, tokenRequired: true, tokens: [TOKEN] }]),
      }),
      maxSsePerUser: 1,
      maxSseGlobal: 100,
      createAdapter: async () => new MockAgentAdapter(),
    });
    apps.push(app);
    const port = await listen(app);

    // 1) 404（会话不存在）→ 404：占位必须释放（否则第 2 步会 429）。
    const missing = await fetch(`http://127.0.0.1:${port}/v1/sessions/no-such/events`, {
      headers: authHeader(TOKEN),
    });
    expect(missing.status).toBe(404);
    await missing.text();

    // 2) 正常会话 → 200：证明 404 未泄漏占位。
    const after404 = await expectReopenable(port, "/v1/sessions/stable/events");

    // 3) 释放第 2 步的流，腾出唯一槽位后再测查询异常路径。
    await closeStream(after404.response, after404.controller);
    // closeStream 只关闭客户端；先用 404 探测确认服务端已释放 after404 的槽位。
    // 若真实泄漏，探测会持续 429 直至超时，不会被后续请求掩盖。
    await expectQuotaSlotAvailable(port);

    // 4) 查询异常：占位释放后交给框架 500（若泄漏，第 5 步会 429）。
    const probeBoom = await fetch(`http://127.0.0.1:${port}/v1/sessions/boom/events`, {
      headers: authHeader(TOKEN),
    });
    expect(probeBoom.status).toBe(500);
    await probeBoom.text();

    // 5) 正常会话 → 200：证明查询异常未泄漏占位。
    const afterBoom = await expectReopenable(port, "/v1/sessions/stable/events");
    await closeStream(afterBoom.response, afterBoom.controller);
  });

  it("socket 工厂失败恰释放占位：后续真实连接可正常建立", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    await seedSession(sessions, "stable");
    let factoryFails = 0;
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      ipAccess: makeTestIpAccess({
        policy: makePolicy([{ ip: USER_IP, tokenRequired: true, tokens: [TOKEN] }]),
      }),
      maxSsePerUser: 1,
      maxSseGlobal: 100,
      sseSocketFactory: (replyRaw, requestRaw) => {
        if (factoryFails === 0) {
          factoryFails++;
          throw new Error("factory-boom");
        }
        return defaultSseSocket(replyRaw, requestRaw);
      },
      createAdapter: async () => new MockAgentAdapter(),
    });
    apps.push(app);
    const port = await listen(app);

    // 1) 工厂失败：占位释放 + 底层连接销毁（客户端看不到任何响应头 → fetch 拒绝）。
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/sessions/stable/events`, { headers: authHeader(TOKEN) }),
    ).rejects.toThrow();

    // 2) 正常会话 → 200：证明工厂失败未泄漏占位。
    const reopened = await expectReopenable(port, "/v1/sessions/stable/events");
    await closeStream(reopened.response, reopened.controller);
  });
});
