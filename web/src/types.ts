// 与 pi-server 协议对齐的类型（对应 src/agent/events.ts 的 SseEvent 与 src/storage 的 SessionRecord）。

export type SseEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "status"; phase: "agent_start" | "turn_start"; requestId?: string }
  | { type: "queued"; position?: number; requestId?: string }
  | { type: "error"; message: string }
  | { type: "completed" }
  | { type: "aborted" };

export type SessionRecord = {
  id: string;
  ownerKey: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

/** 一条会话消息（前端渲染模型）。 */
export type ChatMessage = {
  /** 消息 id（后端 entry id 或前端生成）。 */
  id: string;
  role: "user" | "assistant";
  text: string;
};

/** 一次工具调用的流式卡片状态。 */
export type ToolCall = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
  result: unknown;
  isError: boolean;
  /** tool_end 已收到，调用结束。 */
  done: boolean;
};
