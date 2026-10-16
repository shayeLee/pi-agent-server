import { describe, expect, it } from "vitest";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { ImageInput } from "../../src/agent/agent-adapter.js";
import type { SseEvent } from "../../src/agent/events.js";
import type { SessionCommandInput, SessionCommandResult } from "../../src/shared/commands.js";
import { createChatStore } from "../../src/client/chat-store.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Compaction runs until released; abortCommand makes it fail like Pi's cancelled compaction. */
class CommandAdapter extends MockAgentAdapter {
  readonly commands: SessionCommandInput[] = [];
  private settle?: { resolve: () => void; reject: (error: Error) => void };
  private releasePrompt?: () => void;

  override async prompt(text: string, options?: { images?: ImageInput[] }): Promise<void> {
    await super.prompt(text, options);
    await new Promise<void>(resolve => { this.releasePrompt = resolve; });
  }
  finishStream(): void { this.releasePrompt?.(); }

  async runCommand(input: SessionCommandInput): Promise<SessionCommandResult> {
    this.commands.push(input);
    if (input.command === "reload") return { command: "reload", contextFiles: 1, promptTemplates: 2, skills: 3, extensions: 4 };
    this.emit({ type: "compaction_start", reason: "manual" });
    await new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
    this.emit({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: { summary: "s", tokensBefore: 900, estimatedTokensAfter: 100 } });
    return { command: "compact", tokensBefore: 900, tokensAfter: 100 };
  }
  abortCommand(): void { this.settle?.reject(new Error("Compaction cancelled")); }
  // Pi reports no context token count until the next response after a compaction.
  async getUsageSnapshot() { return { context: { tokens: null, window: 1000, percent: null, estimate: true as const } }; }
  finishCommand(): void { this.settle?.resolve(); }
}

function makeRuntime(adapter = new CommandAdapter()) {
  const events: SseEvent[] = [];
  const runtime = new SessionRuntime({ sessionId: "s1", ownerKey: "owner-1", adapter, now: () => 0, onEvent: event => events.push(event),
    concurrency: new ConcurrencyController({ globalLimit: 2, perUserLimit: 2, perUserQueueLimit: 2, globalQueueLimit: 4, queueTimeoutMs: 5000 }) });
  return { runtime, adapter, events };
}

describe("SessionRuntime host commands", () => {
  it("publishes an idle compaction under its own requestId, refreshes usage and closes it with completed", async () => {
    const { runtime, adapter, events } = makeRuntime();
    const store = createChatStore();
    const pending = runtime.runCommand({ command: "compact", args: "keep decisions" });
    await flush();
    expect(adapter.commands).toEqual([{ command: "compact", args: "keep decisions" }]);
    expect(events).toEqual([{ type: "compaction_start", reason: "manual", requestId: expect.stringMatching(/^command:/) }]);
    // A submission while compacting conflicts instead of racing the rewrite.
    expect(await runtime.submitMessage({ requestId: "r1", prompt: "hi", userId: "owner-1" })).toEqual({ kind: "conflict", reason: "active" });
    adapter.finishCommand();
    expect(await pending).toEqual({ kind: "ok", result: { command: "compact", tokensBefore: 900, tokensAfter: 100 } });
    const requestId = events[0]!.requestId;
    expect(events.map(event => [event.type, event.requestId])).toEqual([["compaction_start", requestId], ["compaction_end", requestId], ["usage", requestId], ["completed", requestId]]);
    expect(events[2]).toMatchObject({ context: { tokens: null, window: 1000 } });
    for (const event of events) store.applyEvent(event);
    expect(store.getState()).toMatchObject({ phase: "completed", compaction: { status: "succeeded", tokensBefore: 900, tokensAfter: 100 },
      stats: { context: { tokens: null, window: 1000 } } });
    // Live clients saw the lifecycle; an export after it must not replay it.
    expect(runtime.compaction).toBeUndefined();
    expect(await runtime.submitMessage({ requestId: "r2", prompt: "next", userId: "owner-1" })).toEqual({ kind: "run" });
    runtime.dispose();
  });

  it("cancels a compaction through abort and reports it aborted", async () => {
    const { runtime, events } = makeRuntime();
    const pending = runtime.runCommand({ command: "compact" });
    await flush();
    expect(await runtime.abort("wrong-request")).toEqual({ kind: "conflict" });
    expect(await runtime.abort()).toEqual({ kind: "ok" });
    expect(await pending).toEqual({ kind: "aborted" });
    expect(events.at(-1)).toEqual({ type: "aborted", requestId: events[0]!.requestId });
    expect(runtime.compaction).toBeUndefined();
    runtime.dispose();
  });

  it("refuses commands while a prompt runs, and reload publishes nothing", async () => {
    const { runtime, adapter, events } = makeRuntime();
    await runtime.submitMessage({ requestId: "r1", prompt: "hi", userId: "owner-1" });
    await flush();
    expect(await runtime.runCommand({ command: "reload" })).toEqual({ kind: "conflict" });
    adapter.finishStream();
    await flush();
    events.length = 0;
    expect(await runtime.runCommand({ command: "reload" })).toEqual({ kind: "ok",
      result: { command: "reload", contextFiles: 1, promptTemplates: 2, skills: 3, extensions: 4 } });
    expect(events).toEqual([]);
    runtime.dispose();
  });

  it("drops stray idle compaction events when no command owns them", async () => {
    const { runtime, adapter, events } = makeRuntime();
    adapter.emit({ type: "compaction_start", reason: "threshold" });
    expect(events).toEqual([]);
    runtime.dispose();
  });

  it("reports adapters without host commands as unsupported", async () => {
    const plain = new MockAgentAdapter();
    const runtime = new SessionRuntime({ sessionId: "s2", ownerKey: "owner-1", adapter: plain, now: () => 0, onEvent: () => {},
      concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 1, queueTimeoutMs: 5000 }) });
    expect(await runtime.runCommand({ command: "compact" })).toEqual({ kind: "unsupported" });
    runtime.dispose();
  });
});
