import { describe, it, expect } from "vitest";
import {
  PiAgentAdapter,
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
});
