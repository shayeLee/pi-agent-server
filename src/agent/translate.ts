// SDK 事件 → SSE 事件翻译（docs/pi-sdk-api.md §9 映射表）
// 纯函数：可映射 → SSE 事件；无法映射或应忽略 → null。
// queued / aborted / error 无直接 SDK 事件，由服务层合成，不在此函数产出。

import type { AgentSdkEvent, SseEvent } from "./events.js";

export function translateSdkEvent(event: AgentSdkEvent): SseEvent | null {
  switch (event.type) {
    case "message_update":
      // thinking_delta 映射为 SSE thinking_delta
      if (event.assistantMessageEvent.type === "thinking_delta") {
        return { type: "thinking_delta", text: event.assistantMessageEvent.delta };
      }
      // 只有 assistantMessageEvent.type === "text_delta" 映射为 text_delta，其余忽略。
      if (event.assistantMessageEvent.type !== "text_delta") return null;
      return { type: "text_delta", text: event.assistantMessageEvent.delta };
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    case "agent_start":
    case "turn_start":
      return { type: "status", phase: event.type };
    case "agent_end":
      // agent_end 非最终完成（带 willRetry、可能继续 retry/continuation/compaction）；忽略。
      return null;
    case "agent_settled":
      // agent_settled 仅表示运行已稳定（不再 retry/continuation），不携带成功结果；
      // 它在 SDK 的 finally 中发出，prompt() 随后可能仍 reject。成功/失败由 prompt() resolve/reject 结算，此处忽略。
      return null;
    default:
      return null;
  }
}
