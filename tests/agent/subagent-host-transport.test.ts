import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readExtensionFixture } from "./subagent-extension-fixture.js";
import { stripTypeScriptTypes } from "node:module";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { SUBAGENT_HOST_TRANSPORT_EVENT, type SubagentHostTransport, type ExtensionCustomMessage } from "../../src/agent/subagent-host-transport.js";
import type { AgentSdkEvent, SseEvent } from "../../src/agent/events.js";
import type { SubagentNotification } from "../../src/agent/subagent-notification.js";
import type { IdempotencyStorePort } from "../../src/application/ports/index.js";

const flush = () => new Promise<void>(r => setTimeout(r, 0));
const payload = (): SubagentNotification => ({ version: 1, notificationId: randomUUID(), runIds: ["run"], text: "原文 — stopped" });
const limits = { globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 2, globalQueueLimit: 2, queueTimeoutMs: 5000 };
function setup(options: { concurrency?: ConcurrencyController; repo?: IdempotencyStorePort } = {}) {
  const busHandlers = new Map<string, (data: unknown) => void>();
  const source = { on: (channel: string, handler: (data: unknown) => void) => { busHandlers.set(channel, handler); return () => { busHandlers.delete(channel); }; } };
  const listeners = new Set<(e: AgentSdkEvent) => void>();
  const events: SseEvent[] = [];
  const concurrency = options.concurrency ?? new ConcurrencyController(limits);
  let finish = () => {};
  let beforeFinish: (() => Promise<void>) | undefined;
  let streaming = false;
  const custom: ExtensionCustomMessage[] = [];
  const users: string[] = [];
  const emit = (event: AgentSdkEvent) => { for (const listener of listeners) listener(event); };
  const run = async () => {
    expect(concurrency.activeCount()).toBe(1); // Quota exists before every SDK turn.
    streaming = true; emit({ type: "agent_start" });
    await new Promise<void>(r => { finish = r; });
    streaming = false;
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    if (beforeFinish) { const callback = beforeFinish; beforeFinish = undefined; await callback(); }
    emit({ type: "agent_settled" });
  };
  const session: AgentSessionLike = {
    get isStreaming() { return streaming; },
    prompt: async text => { users.push(text); await run(); },
    sendCustomMessage: async message => { custom.push(message); if (!streaming) await run(); },
    abort: vi.fn(async () => { streaming = false; finish(); }), clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    steer: async () => {}, followUp: async () => {}, navigateTree: async () => {},
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: vi.fn(() => { streaming = false; finish(); }), setModel: async () => {}, setThinkingLevel: () => {}, messages: [],
  };
  const adapter = new PiAgentAdapter(session, undefined, source);
  let transport!: SubagentHostTransport;
  busHandlers.get(SUBAGENT_HOST_TRANSPORT_EVENT)!({ version: 1, accept: (value: SubagentHostTransport) => { transport = value; } });
  const init = () => new SessionRuntime({ sessionId: "session", ownerKey: "owner", adapter, concurrency,
    now: () => 0, onEvent: e => events.push(e), idempotencyRepo: options.repo });
  return { init, adapter, transport, session, custom, users, events, concurrency, emit, busHandlers,
    finish: () => finish(), beforeFinish: (callback: () => Promise<void>) => { beforeFinish = callback; },
    setStreaming: (value: boolean) => { streaming = value; } };
}

describe("session-local subagent host admission", () => {
  it("fixture session_start identifies the host independently of a missing transport bridge", () => {
    const s = setup(); s.busHandlers.delete(SUBAGENT_HOST_TRANSPORT_EVENT);
    const source = readExtensionFixture();
    const block = source.slice(source.indexOf('\tpi.on("session_start"'), source.indexOf('\n\tpi.on("session_shutdown"'));
    let start = (_event: unknown, _ctx: unknown) => {};
    const pi = { on: (_: string, handler: typeof start) => { start = handler; },
      events: { emit: (channel: string, data: unknown) => { s.busHandlers.get(channel)?.(data); } } };
    const getHost = new Function("pi", "restoreFleetHistory", `let shuttingDown = true; let hostMode = false; let hostTransport; ${stripTypeScriptTypes(block)}; return () => ({ hostMode, hostTransport });`)(pi, () => {});
    start({}, { mode: "json" });
    expect(getHost()).toEqual({ hostMode: true, hostTransport: undefined });
    s.adapter.dispose();
  });
  it("abort then done/conflicting/rejected retries do not unlock notifications; a new admitted user does", async () => {
    const s = setup(); const runtime = s.init();
    await runtime.submitMessage({ requestId: "old", userId: "owner", prompt: "hello" });
    await runtime.abort(); await flush();
    expect(await runtime.submitMessage({ requestId: "old", userId: "owner", prompt: "hello" })).toMatchObject({ kind: "done" });
    expect(await s.transport.post(payload())).toMatchObject({ accepted: false, reason: "cancelled" });
    expect(await runtime.submitMessage({ requestId: "old", userId: "owner", prompt: "different" })).toMatchObject({ kind: "conflict" });
    expect(await s.transport.post(payload())).toMatchObject({ accepted: false, reason: "cancelled" });
    await runtime.submitMessage({ requestId: "new-user", userId: "owner", prompt: "new" });
    expect(await s.transport.post(payload())).toMatchObject({ accepted: true, mode: "followUp", requestId: "new-user" });
    s.finish(); await flush(); runtime.dispose();

    const full = setup({ concurrency: new ConcurrencyController({ ...limits, globalQueueLimit: 0 }) });
    const rf = full.init(); await rf.abort();
    expect(await rf.submitMessage({ requestId: "rejected", userId: "owner", prompt: "new" })).toMatchObject({ kind: "rejected" });
    expect(await full.transport.post(payload())).toMatchObject({ accepted: false, reason: "cancelled" }); rf.dispose();
  });
  it("deferred old-request storage result after abort cannot reopen notification generation", async () => {
    let release!: () => void;
    const repo: IdempotencyStorePort = { get: async (_sid, rid) => {
      if (rid === "old") { await new Promise<void>(r => { release = r; }); return { status: "aborted" }; }
      return null;
    }, put: async () => {}, prune: async () => 0 };
    const s = setup({ repo }); const runtime = s.init(); await runtime.abort();
    const retry = runtime.submitMessage({ requestId: "old", userId: "owner", prompt: "retry" });
    expect(await s.transport.post(payload())).toMatchObject({ accepted: false, reason: "cancelled" });
    release(); expect(await retry).toMatchObject({ kind: "done" });
    expect(await s.transport.post(payload())).toMatchObject({ accepted: false, reason: "cancelled" });
    await runtime.submitMessage({ requestId: "new", userId: "owner", prompt: "genuine" });
    expect(await s.transport.post(payload())).toMatchObject({ accepted: true, requestId: "new" });
    s.finish(); await flush(); runtime.dispose();
  });
  it("pending drain storage await loses to a new user and emits only a foreign request error", async () => {
    let release!: () => void; let defer = false;
    const repo: IdempotencyStorePort = { get: async (_sid, rid) => {
      if (defer && rid !== "new") { await new Promise<void>(r => { release = r; }); }
      return null;
    }, put: async () => {}, prune: async () => 0 };
    const s = setup({ repo }); const runtime = s.init();
    await runtime.submitMessage({ requestId: "old", userId: "owner", prompt: "old" });
    s.setStreaming(false); const ack = await s.transport.post(payload());
    expect(ack).toMatchObject({ accepted: true, mode: "pending" });
    defer = true; s.finish(); await flush();
    await runtime.submitMessage({ requestId: "new", userId: "owner", prompt: "new" });
    release(); await flush();
    expect(s.custom).toHaveLength(0); expect(runtime.state).toBe("streaming");
    expect(s.events.at(-1)).toMatchObject({ type: "error", requestId: (ack as any).requestId });
    expect(s.events.at(-1)?.requestId).not.toBe("new");
    s.finish(); await flush(); runtime.dispose();
  });
  it("handshake starts notready, revoke/dispose never SDK-direct", async () => {
    const s = setup(); const p = payload();
    expect(await s.transport.post(p)).toEqual({ accepted: false, reason: "notready" });
    const runtime = s.init(); runtime.dispose();
    expect(await s.transport.post(p)).toEqual({ accepted: false, reason: "disposed" });
    expect(s.custom).toHaveLength(0);
  });
  it("active streaming queues custom immediately in the owned user request, with synchronous inflight dedup", async () => {
    const s = setup(); const runtime = s.init();
    expect(await runtime.submitMessage({ requestId: "user", userId: "owner", prompt: "hello" })).toEqual({ kind: "run" });
    const p = payload(); const first = s.transport.post(p); const duplicate = s.transport.post(p);
    expect(s.custom).toHaveLength(1);
    expect(await first).toEqual({ accepted: true, mode: "followUp", requestId: "user" });
    expect(await duplicate).toEqual(await first);
    expect(s.custom[0]).toMatchObject({ content: p.text, details: { notificationId: p.notificationId } });
    s.finish(); await flush();
    expect(s.events.filter(e => e.type === "completed")).toEqual([{ type: "completed", requestId: "user" }]);
    expect(s.users).toEqual(["hello"]); runtime.dispose();
  });
  it("settled handler awaits only pending admission, then host release launches a new real request", async () => {
    const s = setup(); const runtime = s.init();
    await runtime.submitMessage({ requestId: "original", userId: "owner", prompt: "hello" });
    const p = payload(); let ack: any;
    s.beforeFinish(async () => { ack = await s.transport.post(p); expect(s.custom).toHaveLength(0); });
    s.finish(); await flush();
    expect(ack).toMatchObject({ accepted: true, mode: "pending" });
    expect(ack.requestId).not.toBe("original"); expect(s.custom).toHaveLength(1);
    expect(s.events.filter(e => e.type === "completed").map(e => e.requestId)).toEqual(["original"]);
    s.finish(); await flush();
    expect(s.events.filter(e => e.type === "completed").map(e => e.requestId)).toEqual(["original", ack.requestId]);
    expect(await s.transport.post(p)).toEqual(ack); expect(s.custom).toHaveLength(1); runtime.dispose();
  });
  it("idle gets quota first and notification display precedes task status; replay stays deduplicated", async () => {
    const s = setup(); const runtime = s.init(); const p = payload();
    s.emit({ type: "entry_appended", entry: { type: "custom", customType: "agent-team:notification", id: "entry", timestamp: "2026-01-01T00:00:00Z", data: p } } as any);
    const ack = await s.transport.post(p); expect(ack).toMatchObject({ accepted: true, mode: "run" });
    expect(s.events[0]).toMatchObject({ type: "notification", notificationId: p.notificationId });
    expect(s.events[1]).toMatchObject({ type: "status", phase: "agent_start", requestId: (ack as any).requestId });
    s.finish(); await flush(); expect(s.events.filter(e => e.type === "completed")).toHaveLength(1);
    expect(s.users).toEqual([]); runtime.dispose();
  });
  it("quota queue and full rejection never call idle SDK; queued abort cannot revive", async () => {
    const concurrency = new ConcurrencyController(limits); concurrency.submit("other", "other", 0);
    const s = setup({ concurrency }); const runtime = s.init();
    const ack = await s.transport.post(payload()); expect(ack).toMatchObject({ accepted: true, mode: "queued" });
    expect(s.custom).toHaveLength(0); await runtime.abort();
    concurrency.finish("other"); await flush(); expect(s.custom).toHaveLength(0);
    expect(await s.transport.post(payload())).toMatchObject({ accepted: false, reason: "cancelled" }); runtime.dispose();
    const full = setup({ concurrency: new ConcurrencyController({ ...limits, globalQueueLimit: 0 }) }); const r = full.init();
    expect(await full.transport.post(payload())).toMatchObject({ accepted: false, reason: "full" }); expect(full.custom).toHaveLength(0); r.dispose();
  });
  it("bounded pending queue is cancelled on abort/dispose, including settled callbacks", async () => {
    for (const action of ["abort", "dispose"] as const) {
      const s = setup(); const runtime = s.init(); await runtime.submitMessage({ requestId: "user", userId: "owner", prompt: "hello" });
      s.setStreaming(false);
      for (let i = 0; i < 32; i++) expect(await s.transport.post(payload())).toMatchObject({ accepted: true, mode: "pending" });
      expect(await s.transport.post(payload())).toMatchObject({ accepted: false, reason: "full" });
      if (action === "abort") await runtime.abort(); else runtime.dispose();
      s.finish(); await flush(); expect(s.custom).toHaveLength(0); runtime.dispose();
    }
  });
  it("poison refuses every later post and session-local transports cannot wake a sibling", async () => {
    const a = setup(); const b = setup(); const ra = a.init(); const rb = b.init();
    await ra.submitMessage({ requestId: "user", userId: "owner", prompt: "hi" });
    a.setStreaming(false); await a.transport.post(payload());
    a.session.abort = async () => { throw new Error("abort failed"); };
    await ra.abort(); await flush();
    expect(await a.transport.post(payload())).toEqual({ accepted: false, reason: "cancelled" });
    expect(a.custom).toHaveLength(0); expect(b.custom).toHaveLength(0);
    expect(await b.transport.post(payload())).toMatchObject({ accepted: true, mode: "run" });
    expect(b.custom).toHaveLength(1); a.finish(); b.finish(); await flush(); ra.dispose(); rb.dispose();
  });
  it("custom tasks share measurement and abort discard; real user starts still reset the gate", async () => {
    const s = setup(); const runtime = s.init(); const ack = await s.transport.post(payload());
    const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    s.emit({ type: "message_start", message: { role: "assistant", usage } });
    s.emit({ type: "message_end", message: { role: "assistant", usage } });
    expect(await s.adapter.getLastUsage()).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    await runtime.abort(); await flush();
    const before = s.events.length;
    s.emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" } });
    expect(s.events).toHaveLength(before);
    expect(s.events.filter(e => e.type === "aborted" && e.requestId === (ack as any).requestId)).toHaveLength(1);
    await runtime.submitMessage({ requestId: "next-user", userId: "owner", prompt: "normal" });
    s.emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "normal reply" } });
    expect(s.events.at(-1)).toMatchObject({ type: "text_delta", text: "normal reply", requestId: "next-user" });
    s.finish(); await flush(); runtime.dispose();
  });
  it("storage-await user competition rechecks ownership, never starts a second turn", async () => {
    let release!: () => void; let calls = 0;
    const repo: IdempotencyStorePort = { get: async () => null, put: async () => {}, prune: async () => 0,
      getWithFingerprint: async () => { if (++calls === 1) await new Promise<void>(r => { release = r; }); return null; } };
    const s = setup({ repo }); const runtime = s.init();
    const post = s.transport.post(payload());
    await runtime.submitMessage({ requestId: "competitor", userId: "owner", prompt: "real user" });
    release(); expect(await post).toMatchObject({ accepted: false, reason: "busy" });
    expect(s.custom).toHaveLength(0); expect(s.users).toEqual(["real user"]); s.finish(); await flush(); runtime.dispose();
  });
  it("abort during idle admission storage await refuses the task; failure never returns a false ACK", async () => {
    let release!: () => void;
    const repo: IdempotencyStorePort = { get: async () => { await new Promise<void>(r => { release = r; }); return null; }, put: async () => {}, prune: async () => 0 };
    const s = setup({ repo }); const runtime = s.init(); const post = s.transport.post(payload());
    await runtime.abort(); release(); expect(await post).toMatchObject({ accepted: false }); expect(s.custom).toHaveLength(0); runtime.dispose();
    const t = setup(); const rt = t.init(); await rt.submitMessage({ requestId: "user", userId: "owner", prompt: "hi" });
    t.session.sendCustomMessage = async () => { throw new Error("SDK queue failure"); };
    expect(await t.transport.post(payload())).toEqual({ accepted: false, reason: "failed" }); rt.dispose();
  });
});
