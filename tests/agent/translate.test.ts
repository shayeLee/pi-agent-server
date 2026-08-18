import { describe, it, expect } from "vitest";
import { translateSdkEvent } from "../../src/agent/translate.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";

// SDK 事件 → SSE 事件翻译（docs/pi-sdk-api.md §9 映射表）
// 纯函数：可映射 → SSE 事件；无法映射或应忽略 → null。

describe("SDK 事件 → SSE 事件翻译（docs/pi-sdk-api.md §9）", () => {
  describe("message_update(text_delta) → text_delta", () => {
    it("携带增量文本 delta", () => {
      const sdk: AgentSdkEvent = {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" },
      };
      expect(translateSdkEvent(sdk)).toEqual({ type: "text_delta", text: "你好" });
    });

    it("thinking_delta → thinking_delta", () => {
      const sdk: AgentSdkEvent = {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考中" },
      };
      expect(translateSdkEvent(sdk)).toEqual({ type: "thinking_delta", text: "思考中" });
    });

    it("非 text_delta/thinking_delta 的 message_update 被忽略（text_start / text_end / start）", () => {
      const cases: AgentSdkEvent[] = [
        { type: "message_update", message: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
        { type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "完整文本" } },
        { type: "message_update", message: {}, assistantMessageEvent: { type: "start" } },
      ];
      for (const sdk of cases) {
        expect(translateSdkEvent(sdk)).toBeNull();
      }
    });
  });

  describe("工具事件", () => {
    it("tool_execution_start → tool_start", () => {
      const sdk: AgentSdkEvent = {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "a.txt" },
      };
      expect(translateSdkEvent(sdk)).toEqual({
        type: "tool_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "a.txt" },
      });
    });

    it("tool_execution_update → tool_update", () => {
      const sdk: AgentSdkEvent = {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "grep",
        args: { pattern: "foo" },
        partialResult: { lines: ["a"] },
      };
      expect(translateSdkEvent(sdk)).toEqual({
        type: "tool_update",
        toolCallId: "call-1",
        toolName: "grep",
        partialResult: { lines: ["a"] },
      });
    });

    it("tool_execution_end → tool_end", () => {
      const sdk: AgentSdkEvent = {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { text: "内容" },
        isError: false,
      };
      expect(translateSdkEvent(sdk)).toEqual({
        type: "tool_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { text: "内容" },
        isError: false,
      });
    });

    it("tool_execution_end 出错时保留 isError", () => {
      const sdk: AgentSdkEvent = {
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName: "bash",
        result: { error: "boom" },
        isError: true,
      };
      expect(translateSdkEvent(sdk)).toEqual({
        type: "tool_end",
        toolCallId: "call-2",
        toolName: "bash",
        result: { error: "boom" },
        isError: true,
      });
    });
  });

  describe("状态与完成", () => {
    it("agent_start → status（phase=agent_start）", () => {
      const sdk: AgentSdkEvent = { type: "agent_start" };
      expect(translateSdkEvent(sdk)).toEqual({ type: "status", phase: "agent_start" });
    });

    it("turn_start → status（phase=turn_start）", () => {
      const sdk: AgentSdkEvent = { type: "turn_start" };
      expect(translateSdkEvent(sdk)).toEqual({ type: "status", phase: "turn_start" });
    });

    it("agent_end（非最终完成）→ null（可能 retry/continuation）", () => {
      const sdk: AgentSdkEvent = { type: "agent_end", messages: [], willRetry: false };
      expect(translateSdkEvent(sdk)).toBeNull();
    });

    it("agent_settled（仅稳定，非成功结果）→ null", () => {
      const sdk: AgentSdkEvent = { type: "agent_settled" };
      expect(translateSdkEvent(sdk)).toBeNull();
    });
  });

  describe("应忽略的 SDK 事件（返回 null）", () => {
    it.each<[string, AgentSdkEvent]>([
      ["message_start", { type: "message_start" }],
      ["message_end", { type: "message_end" }],
      ["turn_end", { type: "turn_end" }],
      ["agent_settled", { type: "agent_settled" }],
      ["queue_update", { type: "queue_update", steering: [], followUp: ["x"] }],
      ["compaction_start", { type: "compaction_start", reason: "threshold" }],
      ["compaction_end", { type: "compaction_end" }],
      ["auto_retry_start", { type: "auto_retry_start", attempt: 1, maxAttempts: 3 }],
      ["auto_retry_end", { type: "auto_retry_end" }],
      ["bash_execution_update", { type: "bash_execution_update", delta: "out" }],
    ])("忽略 %s", (_name, sdk) => {
      expect(translateSdkEvent(sdk)).toBeNull();
    });
  });
});
