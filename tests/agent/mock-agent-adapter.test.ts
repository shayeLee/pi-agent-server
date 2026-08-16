import { describe, it, expect } from "vitest";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentAdapter } from "../../src/agent/agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";

// MockAgentAdapter：可控 mock（docs/architecture.md §2 外部依赖经接口接入，单元测试用 mock，不碰真实 Pi SDK）。

describe("MockAgentAdapter", () => {
  it("实现 AgentAdapter 接口（prompt/steer/followUp/abort/subscribe）", () => {
    const adapter: AgentAdapter = new MockAgentAdapter();
    expect(typeof adapter.prompt).toBe("function");
    expect(typeof adapter.steer).toBe("function");
    expect(typeof adapter.followUp).toBe("function");
    expect(typeof adapter.abort).toBe("function");
    expect(typeof adapter.subscribe).toBe("function");
  });

  describe("按预设顺序发射 SDK 事件", () => {
    it("prompt() 时按构造顺序发射预设事件", async () => {
      const events: AgentSdkEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ];
      const adapter = new MockAgentAdapter(events);
      const received: AgentSdkEvent[] = [];
      adapter.subscribe((e) => received.push(e));

      await adapter.prompt("hello");

      expect(received).toEqual(events);
      expect(adapter.emitted).toEqual(events);
    });

    it("emit() 向订阅者即时投递单个事件", () => {
      const adapter = new MockAgentAdapter();
      const received: AgentSdkEvent[] = [];
      adapter.subscribe((e) => received.push(e));

      const event: AgentSdkEvent = {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: {},
      };
      adapter.emit(event);

      expect(received).toEqual([event]);
      expect(adapter.emitted).toEqual([event]);
    });

    it("enqueue() 追加的事件在下次运行方法时发射", async () => {
      const adapter = new MockAgentAdapter();
      const received: AgentSdkEvent[] = [];
      adapter.subscribe((e) => received.push(e));

      adapter.enqueue({ type: "turn_start" });
      await adapter.prompt("再问");

      expect(received).toEqual([{ type: "turn_start" }]);
    });

    it("subscribe 返回的退订函数停止接收后续事件", async () => {
      const adapter = new MockAgentAdapter([{ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false }]);
      const received: AgentSdkEvent[] = [];
      const unsubscribe = adapter.subscribe((e) => received.push(e));

      await adapter.prompt("第一次");
      unsubscribe();
      await adapter.prompt("第二次");

      expect(received).toEqual([{ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false }]);
    });

    it("多个订阅者都收到事件", async () => {
      const adapter = new MockAgentAdapter([{ type: "agent_start" }]);
      const a: AgentSdkEvent[] = [];
      const b: AgentSdkEvent[] = [];
      adapter.subscribe((e) => a.push(e));
      adapter.subscribe((e) => b.push(e));

      await adapter.prompt("x");

      expect(a).toEqual([{ type: "agent_start" }]);
      expect(b).toEqual([{ type: "agent_start" }]);
    });
  });

  describe("记录调用", () => {
    it("记录 prompt/steer/followUp/abort 调用与参数", async () => {
      const adapter = new MockAgentAdapter();
      await adapter.prompt("问题一");
      await adapter.steer("打断指令");
      await adapter.followUp("追加指令");
      await adapter.abort();

      expect(adapter.calls).toEqual([
        { method: "prompt", text: "问题一" },
        { method: "steer", text: "打断指令" },
        { method: "followUp", text: "追加指令" },
        { method: "abort" },
      ]);
    });
  });

  describe("支持 abort", () => {
    it("abort() 置 aborted 标记并清空未发射的预设事件", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_start" },
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const received: AgentSdkEvent[] = [];
      adapter.subscribe((e) => received.push(e));

      await adapter.abort();
      await adapter.prompt("hello");

      expect(adapter.aborted).toBe(true);
      expect(received).toEqual([]);
      expect(adapter.emitted).toEqual([]);
    });

    it("abort 不发射 SSE 事件（aborted 由服务层合成，docs/pi-sdk-api.md §9）", async () => {
      const adapter = new MockAgentAdapter();
      const received: AgentSdkEvent[] = [];
      adapter.subscribe((e) => received.push(e));

      await adapter.abort();

      expect(received).toEqual([]);
    });
  });
});
