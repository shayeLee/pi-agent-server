// 与 pi-agent-server 协议对齐的类型（对应 src/agent/events.ts 的 SseEvent 与 src/storage 的 SessionRecord）。

export type SseEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "status"; phase: "agent_start" | "turn_start"; requestId?: string }
  | { type: "queued"; position?: number; requestId?: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; durationMs: number; ttftMs: number }
  | { type: "error"; message: string }
  | { type: "completed" }
  | { type: "aborted" };

export type UsageStats = {
  durationMs: number;
  ttftMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type SessionRecord = {
  id: string;
  ownerKey: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  systemPrompt: string | null;
};

/** 项目（多项目：默认项目 + 额外项目）。 */
export type Project = {
  id: string;
  name: string;
  cwd: string;
  /**
   * 默认项目（服务端固定 AGENT_CWD：共享、不可删，id 为服务端 DEFAULT_PROJECT_ID 常量）。
   * Web 不硬编码任何默认项目 id，一律由该字段从项目列表中推导 active project。
   */
  isDefault: boolean;
};

/** 可用模型信息。 */
export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
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

/** 聊天区按时间顺序的统一条目：消息、思考或工具调用，按 SSE 事件到达顺序交错排列。 */
export type TimelineItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      /** 是否仍在流式接收增量（未完成）。 */
      streaming: boolean;
    }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; call: ToolCall };

/** 调试面板的一条原始事件日志。 */
export type EventLogEntry = {
  seq: number;
  time: string;
  type: string;
  data: unknown;
};
