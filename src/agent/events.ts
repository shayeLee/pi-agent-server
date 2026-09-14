// Agent 事件类型（needs.md §4.2 / docs/pi-sdk-api.md §9）
// SDK 事件：Pi AgentSession.subscribe 产生的 AgentSessionEvent 相关子集，结构定义、不依赖真实 SDK 类型，
// 便于 mock 与纯逻辑单测（docs/architecture.md §2）。
// SSE 事件：服务层协议（11 种）。queued / aborted / error 无直接 SDK 事件，由服务层合成；
// translate 只产出由 SDK 事件映射得到的部分。

// --- SDK 事件（相关子集） ---

// message_update 携带的助手消息流事件；只有 text_delta 映射为 SSE text_delta，其余忽略。
export type SdkAssistantMessageEvent =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "start" };

export type SdkMessageUpdateEvent = {
  type: "message_update";
  message: unknown;
  assistantMessageEvent: SdkAssistantMessageEvent;
};

export type SdkToolExecutionStartEvent = {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
};

export type SdkToolExecutionUpdateEvent = {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
};

export type SdkToolExecutionEndEvent = {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

export type SdkAgentStartEvent = { type: "agent_start" };

export type SdkTurnStartEvent = { type: "turn_start" };

export type SdkAgentEndEvent = {
  type: "agent_end";
  messages: Array<{
    role: string;
    stopReason?: string;
    errorMessage?: string;
  }>;
  willRetry?: boolean;
};

/** SDK 完全稳定完成信号（run 结束、retry/continuation/compaction 全部结束后发出）；服务层不以其结算终态（以 prompt resolve + stopReason 为准），仅作参考。 */
export type SdkAgentSettledEvent = { type: "agent_settled" };

// 无 SSE 映射、translate 应忽略的 SDK 事件（相关子集）。
export type SdkIgnoredEvent =
  | { type: "message_start"; message?: unknown }
  | { type: "message_end"; message?: unknown }
  | { type: "turn_end" }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end" }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number }
  | { type: "auto_retry_end" }
  | { type: "bash_execution_update"; delta: string };

// subscribe 产出的 SDK 事件流元素。
export type AgentSdkEvent =
  | SdkMessageUpdateEvent
  | SdkToolExecutionStartEvent
  | SdkToolExecutionUpdateEvent
  | SdkToolExecutionEndEvent
  | SdkAgentStartEvent
  | SdkAgentEndEvent
  | SdkAgentSettledEvent
  | SdkTurnStartEvent
  | SdkIgnoredEvent;

/** 从 agent_end 的 messages 中提取最终 assistant 消息的 stopReason/errorMessage（结果权威，needs.md §4.2）。 */
export function extractFinalStop(
  messages: SdkAgentEndEvent["messages"],
): { stopReason: string | null; errorMessage: string | null } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.stopReason) {
      return { stopReason: m.stopReason, errorMessage: m.errorMessage ?? null };
    }
  }
  return { stopReason: null, errorMessage: null };
}

// --- SSE 事件（needs.md §4.2，11 种） ---

/**
 * turn 关联字段（P7b）：同一轮对话的所有事件都携带产生它们的 `requestId`，
 * 客户端据此把“迟到/补发”的旧事件与新请求隔离，不跨 request 串扰。
 *
 * 可选仅用于**非 turn 遗留场景**（如宿主合成的无请求上下文事件）；正常 turn 的
 * 发射路径（`SessionRuntime`）必须携带具体值，且测试断言其存在。
 */
export type SseRequestId = { readonly requestId?: string };

export type SseEvent =
  | ({ type: "text_delta"; text: string } & SseRequestId)
  | ({ type: "thinking_delta"; text: string } & SseRequestId)
  | ({ type: "tool_start"; toolCallId: string; toolName: string; args: unknown } & SseRequestId)
  | ({ type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown } & SseRequestId)
  | ({ type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean } & SseRequestId)
  | ({ type: "status"; phase: "agent_start" | "turn_start" } & SseRequestId)
  | ({ type: "queued"; position?: number } & SseRequestId)
  | ({ type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; durationMs: number; ttftMs: number } & SseRequestId)
  | ({ type: "error"; message: string } & SseRequestId)
  | ({ type: "completed" } & SseRequestId)
  | ({ type: "aborted" } & SseRequestId);
