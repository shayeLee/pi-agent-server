import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionMetrics, EXECUTION_METRICS_TYPE, projectExecutionSnapshot } from "../../src/agent/execution-metrics.js";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent, SseEvent } from "../../src/agent/events.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { createChatStore } from "../../src/client/chat-store.js";
import { readPiJsonlExport } from "../../src/agent/pi-jsonl-conversation-storage.js";
import type { ExtensionCustomMessage, SubagentHostTransport } from "../../src/agent/subagent-host-transport.js";
import { SUBAGENT_HOST_TRANSPORT_EVENT } from "../../src/agent/subagent-host-transport.js";

function fixture(manager = SessionManager.inMemory()) {
  const listeners = new Set<(e: AgentSdkEvent) => void>();
  const emit = (event: AgentSdkEvent) => { for (const listener of listeners) listener(event); };
  let finish!: () => void; let streaming = false;
  const run = async () => { streaming = true; emit({ type: "agent_start" }); emit({ type: "turn_start" }); await new Promise<void>(r => { finish = r; }); streaming = false; emit({ type: "agent_settled" }); };
  const session: AgentSessionLike = {
    messages: [], sessionManager: manager, get isStreaming() { return streaming; },
    prompt: async text => { manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }); await run(); },
    sendCustomMessage: async (message: ExtensionCustomMessage) => { manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); if (!streaming) await run(); },
    subscribe: l => { listeners.add(l); return () => { listeners.delete(l); }; },
    abort: async () => { finish?.(); }, clearQueue: () => ({ steering: [], followUp: [] }),
    steer: async () => {}, followUp: async () => {}, navigateTree: async id => { manager.branch(id); },
    setModel: async () => {}, setThinkingLevel: () => {}, dispose: () => {},
  };
  const handlers = new Map<string, (data: unknown) => void>();
  const adapter = new PiAgentAdapter(session, undefined, { on: (channel, handler) => { handlers.set(channel, handler); return () => {}; } });
  let transport!: SubagentHostTransport;
  handlers.get(SUBAGENT_HOST_TRANSPORT_EVENT)!({ version: 1, accept: (t: SubagentHostTransport) => { transport = t; } });
  const events: SseEvent[] = [];
  const concurrency = new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 1, perUserQueueLimit: 1, queueTimeoutMs: 1000 });
  const runtime = new SessionRuntime({ adapter, sessionId: "s", ownerKey: "o", now: () => 1, onEvent: e => events.push(e), concurrency });
  return { manager, session, adapter, runtime, transport, emit, events, concurrency, finish: () => finish() };
}
const tick = () => new Promise(r => setTimeout(r, 0));
const notify = (_id: string) => ({ version: 1 as const, notificationId: randomUUID(), runIds: ["run"], text: "same" });

describe("durable real host loops / SDK turns", () => {
  it("user + tools + active custom follow-up share a loop; idle custom starts another; retry starts another turn not loop", async () => {
    const f = fixture();
    expect(f.adapter.getExecutionSnapshot()).toMatchObject({ totalLoops: 0, totalTurns: 0, coverage: "complete" });
    await f.runtime.submitMessage({ requestId: "r", userId: "o", prompt: "same" });
    f.emit({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} });
    f.emit({ type: "tool_execution_end", toolCallId: "t", toolName: "read", result: "ok", isError: false });
    f.emit({ type: "turn_end" }); f.emit({ type: "turn_start" });
    expect(await f.transport.post(notify("active"))).toMatchObject({ mode: "followUp", requestId: "r" });
    f.emit({ type: "turn_end" }); f.emit({ type: "turn_start" });
    f.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }], willRetry: true });
    f.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2 });
    f.emit({ type: "agent_start" }); f.emit({ type: "turn_start" });
    expect(f.adapter.getExecutionSnapshot()).toMatchObject({ totalLoops: 1, totalTurns: 4 });
    f.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    f.finish(); await tick();
    expect(await f.transport.post(notify("idle"))).toMatchObject({ mode: "run" });
    expect(f.adapter.getExecutionSnapshot()).toMatchObject({ totalLoops: 2, totalTurns: 5 });
    f.finish(); await tick();
    const exported = await f.adapter.exportSession() as any;
    expect(exported.usageSnapshot.execution).toEqual(f.adapter.getExecutionSnapshot());
    const store = createChatStore(); for (const e of f.events) store.applyEvent(e);
    const usage = f.events.filter(e => e.type === "usage").at(-1)!;
    store.applyEvent(usage); store.applyEvent(usage);
    expect(store.getState().stats?.execution).toMatchObject({ totalLoops: 2, totalTurns: 5 });
    const unsub = f.adapter.subscribe(() => {}); unsub(); f.adapter.subscribe(() => {});
    expect(f.adapter.getExecutionSnapshot().totalTurns).toBe(5);
    f.runtime.dispose();
  });
  it("abort before execution adds nothing; after actual start still counts once; same text is not an identity", async () => {
    const f = fixture();
    const signal = AbortSignal.abort();
    await f.runtime.runTurn({ requestId: "never", prompt: "same", signal });
    expect(f.adapter.getExecutionSnapshot().totalLoops).toBe(0);
    await f.runtime.submitMessage({ requestId: "r", userId: "o", prompt: "same" });
    await f.runtime.abort(); await tick();
    expect(f.adapter.getExecutionSnapshot()).toMatchObject({ totalLoops: 1, totalTurns: 1 });
    await f.runtime.submitMessage({ requestId: "r2", userId: "o", prompt: "same" });
    expect(f.adapter.getExecutionSnapshot()).toMatchObject({ totalLoops: 2, totalTurns: 2 });
    f.finish(); await tick(); f.runtime.dispose();
  });
  it("cancelled queued/navigation preflight never begins a loop", async () => {
    const f = fixture();
    f.concurrency.submit("other", "other", 0);
    expect(await f.runtime.submitMessage({ requestId: "queued", userId: "o", prompt: "same" })).toMatchObject({ kind: "queued" });
    await f.runtime.abort(); f.concurrency.finish("other");
    expect(f.adapter.getExecutionSnapshot()).toMatchObject({ totalLoops: 0, totalTurns: 0 });
    let release!: () => void;
    f.session.navigateTree = async () => { await new Promise<void>(r => { release = r; }); };
    await f.runtime.submitMessage({ requestId: "preflight", userId: "o", prompt: "same", parentId: "node" });
    await f.runtime.abort(); release(); await tick();
    expect(f.adapter.getExecutionSnapshot()).toMatchObject({ totalLoops: 0, totalTurns: 0 });
    f.runtime.dispose();
  });
  it("compaction/end events do not fabricate turns; failed persistence is unknown, not zero", () => {
    const manager = SessionManager.inMemory();
    const m = new ExecutionMetrics(manager); m.begin(); m.observe({ type: "agent_start" });
    m.observe({ type: "compaction_start" }); m.observe({ type: "compaction_end" }); m.observe({ type: "turn_start" });
    m.observe({ type: "turn_end" }); m.observe({ type: "turn_end" }); m.observe({ type: "agent_end" });
    expect(m.snapshot()).toMatchObject({ totalLoops: 1, totalTurns: 1 });
    expect(manager.getEntries()).toHaveLength(3);
    const failure = new ExecutionMetrics({ getEntries: () => [], appendCustomEntry: () => { throw new Error("disk full"); } });
    failure.begin(); failure.observe({ type: "turn_start" });
    expect(failure.snapshot()).toMatchObject({ coverage: "unknown", totalLoops: null, totalTurns: null, recordedLoops: null });
  });
  it("old history is unknown then recorded-only; duplicated IDs/fork inherited entries deduplicate, context stays clean", () => {
    const manager = SessionManager.inMemory(); manager.appendMessage({ role: "user", content: "old", timestamp: 0 });
    const m = new ExecutionMetrics(manager);
    expect(m.snapshot()).toMatchObject({ coverage: "unknown", totalLoops: null, recordedLoops: null });
    m.begin(); const start = { type: "turn_start" }; m.observe(start); m.observe(start);
    expect(m.snapshot()).toMatchObject({ coverage: "recorded", totalLoops: null, totalTurns: null, recordedLoops: 1, recordedTurns: 1 });
    const entries = manager.getEntries();
    expect(projectExecutionSnapshot([...entries, ...entries])).toEqual(m.snapshot());
    expect(manager.buildSessionContext().messages).toHaveLength(1);
    expect(entries.filter(e => e.type === "custom" && e.customType === EXECUTION_METRICS_TYPE)).toHaveLength(3);
  });
  it("JSONL restart and read-only export restore all branches, not only selected context", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loop-turn-"));
    try {
      const manager = SessionManager.create(dir, dir);
      const f = fixture(manager); await f.runtime.submitMessage({ requestId: "r", userId: "o", prompt: "same" }); f.finish(); await tick();
      const first = manager.getEntries().find(e => e.type === "message")!.id;
      manager.branch(first);
      await f.runtime.submitMessage({ requestId: "r2", userId: "o", prompt: "same" }); f.finish(); await tick();
      const file = manager.getSessionFile()!;
      expect(new ExecutionMetrics(SessionManager.open(file)).snapshot()).toMatchObject({ totalLoops: 2, totalTurns: 2 });
      expect((await readPiJsonlExport(file) as any).usageSnapshot.execution).toEqual(f.adapter.getExecutionSnapshot());
      f.runtime.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("old server missing fields never derives counts from user messages; replay cannot roll back and foreign requests cannot pollute", () => {
    const store = createChatStore(); store.addUserMessage("same", "u", "r");
    store.applyEvent({ type: "status", phase: "agent_start", requestId: "r" });
    expect(store.getState().stats).toBeNull();
    const snapshot = { scope: "allEntries" as const, coverage: "complete" as const, totalLoops: 2, totalTurns: 4, recordedLoops: 2, recordedTurns: 4 };
    store.applyEvent({ type: "status", phase: "turn_start", requestId: "r", execution: snapshot });
    store.applyEvent({ type: "status", phase: "turn_start", requestId: "foreign", execution: { ...snapshot, totalLoops: 99, recordedLoops: 99 } });
    store.applyEvent({ type: "status", phase: "turn_start", requestId: "r", execution: { ...snapshot, totalLoops: 1, recordedLoops: 1 } });
    store.restoreExecution({ ...snapshot, totalTurns: 1, recordedTurns: 1 });
    expect(store.getState().stats?.execution).toEqual(snapshot);
  });
});
