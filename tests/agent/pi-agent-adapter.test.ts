import { describe, it, expect, vi } from "vitest";
import {
  PiAgentAdapter,
  STEPS_CHANGED_WINDOW_MS,
  type AgentSessionLike,
  type SdkImageContent,
} from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";

/** 可控 fake：记录调用、可按需向订阅者投递事件。 */
class FakeSession implements AgentSessionLike {
  readonly calls: string[] = [];
  messages: unknown[] = [];
  private listener?: (event: AgentSdkEvent) => void;

  async prompt(text: string, _options?: { images?: SdkImageContent[] }): Promise<void> {
    this.calls.push(`prompt:${text}`);
  }
  async steer(text: string): Promise<void> {
    this.calls.push(`steer:${text}`);
  }
  async followUp(text: string): Promise<void> {
    this.calls.push(`followUp:${text}`);
  }
  async abort(): Promise<void> {
    this.calls.push("abort");
  }
  async navigateTree(targetId: string): Promise<void> {
    this.calls.push(`navigateTree:${targetId}`);
  }
  async setModel(_model: unknown): Promise<void> {
    this.calls.push("setModel");
  }
  setThinkingLevel(_level: unknown): void {
    this.calls.push("setThinkingLevel");
  }
  subscribe(listener: (event: AgentSdkEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  dispose(): void {
    this.calls.push("dispose");
  }

  /** 向已订阅的监听器投递一个 SDK 事件（模拟 SDK 事件流）。 */
  emit(event: AgentSdkEvent): void {
    this.listener?.(event);
  }
}

describe("PiAgentAdapter（接入真实 AgentSession 的适配层）", () => {
  it("acknowledges only the exact queued user object, not equal text, copied images or duplicate events", async () => {
    const session = new FakeSession();
    const queued: any[] = [];
    const agent = { streamFunction: () => {}, steer: (message: object) => { queued.push(message); } };
    Object.assign(session, { agent, steer: async (text: string, images?: SdkImageContent[]) => {
      await Promise.resolve();
      agent.steer({ role: "user", content: [{ type: "text", text }, ...(images ?? [])] });
    } });
    const adapter = new PiAgentAdapter(session);
    const consumed: unknown[] = [];
    await adapter.prompt("primary"); // Establish the request lifecycle owning the queued steering.
    adapter.subscribeSteeringConsumed(identity => consumed.push(identity));
    const first = { controlId: "one", acknowledgementId: "token", requestId: "primary", images: [{ mediaType: "image/png", base64: "aGVsbG8=" }] };
    await adapter.steer("same", first);
    await session.steer("same"); // An unrelated SDK/user submission with identical text.
    session.emit({ type: "message_start", message: queued[1] });
    session.emit({ type: "message_start", message: { ...queued[0] } });
    session.emit({ type: "message_start", message: { role: "assistant", content: queued[0].content } });
    expect(consumed).toHaveLength(0);
    session.emit({ type: "message_start", message: queued[0] });
    session.emit({ type: "message_start", message: queued[0] });
    expect(consumed).toEqual([{ controlId: "one", acknowledgementId: "token", requestId: "primary" }]);
    expect(queued[0].content[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    adapter.dispose();
  });
  it("dedicated entry subscription survives abort discard and rejects malformed/unknown/disposed entries", async () => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    const received: unknown[] = [];
    adapter.subscribeNotifications(event => received.push(event));
    const entry = { type: "custom", customType: "agent-team:notification", id: "marker", timestamp: "2026-01-01T00:00:00Z", data: { version: 1, notificationId: "8b58f83a-b77d-4e31-99de-47753962fb0f", runIds: ["run"], text: "stopped" } };
    await adapter.abort();
    session.emit({ type: "entry_appended", entry } as any);
    session.emit({ type: "entry_appended", entry: { ...entry, customType: "unknown" } } as any);
    session.emit({ type: "entry_appended", entry: { ...entry, data: {} } } as any);
    expect(received).toHaveLength(1);
    adapter.dispose(); session.emit({ type: "entry_appended", entry } as any);
    expect(received).toHaveLength(1);
  });
  it("maps real SDK usage and preserves total including cache without guessing", async () => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    await adapter.prompt("usage");
    session.messages.push({ role: "assistant", usage: { input: 120, output: 8, cacheRead: 20, cacheWrite: 12, totalTokens: 160 } });
    expect(await adapter.getLastUsage()).toEqual({ promptTokens: 120, completionTokens: 8, totalTokens: 160 });
  });

  it("returns measured zero, never historical or earlier assistant usage", async () => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    session.messages.push({ role: "assistant", usage: { input: 120, output: 8, totalTokens: 160 } });
    expect(await adapter.getLastUsage()).toBeNull();
    await adapter.prompt("zero");
    session.messages.push({ role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
    expect(await adapter.getLastUsage()).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    session.messages.push({ role: "assistant" });
    expect(await adapter.getLastUsage()).toBeNull();
    await adapter.prompt("no assistant");
    expect(await adapter.getLastUsage()).toBeNull();
  });

  it("does not read a shifted historical message after the request boundary is replaced", async () => {
    const session = new FakeSession();
    session.messages = [{ role: "user", content: "history" }];
    const adapter = new PiAgentAdapter(session);
    await adapter.prompt("current");
    session.messages = [{ role: "user", content: "other branch" }, { role: "assistant", usage: { input: 120, output: 8, totalTokens: 160 } }];
    expect(await adapter.getLastUsage()).toBeNull();
  });

  it.each([undefined, { promptTokens: 120, completionTokens: 8, totalTokens: 160 }, { input: NaN, output: 8, totalTokens: 160 }, { input: 120, output: 8 }])("missing or invalid SDK measurement is unknown: %j", async (usage) => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    await adapter.prompt("unknown");
    session.messages.push({ role: "assistant", usage });
    expect(await adapter.getLastUsage()).toBeNull();
  });

  it("prompt 转发到 session", async () => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    await adapter.prompt("你好");
    expect(session.calls).toEqual(["prompt:你好"]);
  });

  it("steer / followUp / abort / navigateTree 转发到 session", async () => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    await adapter.steer("改");
    await adapter.followUp("追加");
    await adapter.abort();
    await adapter.navigateTree("a1b2c3d4");
    expect(session.calls).toEqual(["steer:改", "followUp:追加", "abort", "navigateTree:a1b2c3d4"]);
  });

  it("subscribe 转发：SDK 事件直达监听器", () => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    const received: AgentSdkEvent[] = [];
    adapter.subscribe((e) => received.push(e));

    const event: AgentSdkEvent = { type: "agent_start" };
    session.emit(event);
    expect(received).toEqual([event]);
  });

  it("subscribe 返回退订函数，退订后不再收到", () => {
    const session = new FakeSession();
    const adapter = new PiAgentAdapter(session);
    const received: AgentSdkEvent[] = [];
    const unsubscribe = adapter.subscribe((e) => received.push(e));

    unsubscribe();
    session.emit({ type: "agent_start" });
    expect(received).toEqual([]);
  });

  it("每轮只包稳定 stream base：取消旧轮后新轮可用，旧 continuation 不会借新 token 复活", async () => {
    const session = new FakeSession() as FakeSession & { agent: { streamFunction: (...args: any[]) => string } };
    const base = (...args: any[]) => `base:${args[2]?.signal?.aborted}`;
    session.agent = { streamFunction: base };
    const adapter = new PiAgentAdapter(session);

    await adapter.prompt("one");
    const oldContinuation = session.agent.streamFunction;
    await adapter.abort();
    await adapter.prompt("two");
    const newContinuation = session.agent.streamFunction;

    expect(newContinuation).not.toBe(oldContinuation);
    expect(newContinuation("m", [], {})).toBe("base:false");
    expect(() => oldContinuation("m", [], {})).toThrow(/Aborted/);
    // A third turn replaces rather than wraps the second gate (the base receives one signal).
    await adapter.prompt("three");
    expect(session.agent.streamFunction("m", [], {})).toBe("base:false");
  });
});

describe("steps_changed coalescing", () => {
  it("signals at most once per window and always delivers the final position", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession();
      const adapter = new PiAgentAdapter(session);
      const positions: { projectionId: string; revision: number }[] = [];
      adapter.subscribeStepsChanged(position => positions.push(position));
      const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
      session.emit({ type: "message_start", message: message("a") } as AgentSdkEvent);
      const update = (text: string) => ({ type: "message_update", message: message(text), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(-1) } }) as unknown as AgentSdkEvent;
      for (const text of ["ab", "abc", "abcd"]) session.emit(update(text));
      expect(positions).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS);
      expect(positions).toHaveLength(1);
      expect(positions[0]!.revision).toBe(adapter.getSessionSteps("s").revision);
      session.emit(update("abcde"));
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS);
      expect(positions).toHaveLength(2);
      expect(positions[1]!.revision).toBeGreaterThan(positions[0]!.revision);
      // Nothing moved: nothing more is signalled.
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS * 4);
      expect(positions).toHaveLength(2);
      adapter.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("subagents_changed coalescing", () => {
  it("signals transcript, live-output and legacy result changes at most once per window, final change included", async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, (data: unknown) => void>();
      const bus = { on: (channel: string, handler: (data: unknown) => void) => { handlers.set(channel, handler); return () => { handlers.delete(channel); }; } };
      const session = new FakeSession();
      const adapter = new PiAgentAdapter(session, undefined, bus);
      const revisions: number[] = [];
      adapter.subscribeSubagentsChanged(revision => revisions.push(revision));
      const transcript = handlers.get("agent-team:transcript")!;
      const live = handlers.get("agent-team:transcript-live")!;
      transcript({ version: 1, id: "r1", kind: "start" });
      live({ id: "r1", revision: 1 });
      live({ id: "r1", revision: 2 });
      expect(revisions).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS);
      expect(revisions).toHaveLength(1);
      // Live output for an unknown run is not this session's child.
      live({ id: "other", revision: 1 });
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS);
      expect(revisions).toHaveLength(1);
      transcript({ version: 1, id: "r1", kind: "end" });
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS);
      expect(revisions).toHaveLength(2);
      expect(revisions[1]!).toBeGreaterThan(revisions[0]!);
      // A legacy build records the run only in the collected tool result.
      session.emit({ type: "message_end", message: { role: "toolResult", toolName: "subagent_wait", content: [] } } as unknown as AgentSdkEvent);
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS);
      expect(revisions).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(STEPS_CHANGED_WINDOW_MS * 4);
      expect(revisions).toHaveLength(3);
      adapter.dispose();
    } finally { vi.useRealTimers(); }
  });
});

