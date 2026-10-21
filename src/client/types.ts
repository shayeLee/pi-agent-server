// Transport and application-state contracts for pi-agent-server clients.
import type { UsageSnapshot } from "../core/usage-snapshot.js";
export type { UsageSnapshot, UsageTokens, LastResponseUsage, ExecutionSnapshot, PromptUsage, SubagentUsage } from "../core/usage-snapshot.js";

/**
 * turn 关联字段：同一轮对话的所有 SSE 事件都携带产生它们的 `requestId`，
 * 前端据此把迟到/补发的旧事件与新请求隔离。可选仅用于非 turn 遗留场景。
 */
export type { SseRequestId, SseEvent, ModelOutputProgress, CompactionState, CompactionReason } from "../shared/events.js";

export type UsageStats = UsageSnapshot & {
  durationMs: number;
  ttftMs: number;
  /** null means unavailable; zero is a measured SDK value. */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type SessionRecord = {
  id: string;
  ownerKey: string;
  /** Missing fields in older servers mean private/managed. */
  visibility?: "private" | "shared";
  origin?: "managed" | "native";
  projectId: string;
  title: string;
  /** Read-only first user prompt; empty string means the first message had no text. */
  firstPrompt?: string | null;
  createdAt: number;
  updatedAt: number;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  systemPrompt: string | null;
};

/** 宿主访问能力投影（`GET /v1/access`）：由服务端中央 RBAC 矩阵派生。 */
export type AccessCapabilities = {
  canRead: boolean;
  canWrite: boolean;
};

/** 项目（多项目：默认项目 + 额外项目）。 */
export type Project = {
  id: string;
  name: string;
  cwd: string;
  /**
   * 默认项目（服务端固定 AGENT_CWD：共享、不可删，id 为服务端 DEFAULT_PROJECT_ID 常量）。
   * Empty default projects may be omitted; DEFAULT_PROJECT_ID remains a valid creation target.
   */
  isDefault: boolean;
  canDelete?: boolean;
  canCreateSession?: boolean;
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
  /** SDK tool execution time, not subagent child runtime; historical values may be absent. */
  durationMs?: number | null;
  /** tool_end 已收到，调用结束。 */
  done: boolean;
  /** 这次调用在运行中发起的工具调用（codemode 脚本里的 MCP 调用等）；它们不单独占时间线条目。 */
  nested?: import("../shared/nested-tool-calls.js").NestedToolCalls;
};

/** 聊天区按时间顺序的统一条目：消息、思考或工具调用，按 SSE 事件到达顺序交错排列。 */
export type TimelineItem =
  | ({ kind: "notification"; id: string } & Omit<import("../shared/events.js").NotificationEvent, "type" | "requestId">)
  /** An extension command run from the composer (`/antigravity.usage`) and what it showed. */
  | ({ kind: "command"; id: string } & Omit<import("../shared/events.js").CommandOutputEvent, "type" | "requestId">)
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      /** Provenance supplied by a read-only child conversation. */
      sourceLabel?: string;
      /** In a child conversation: this user turn is the host agent's input of that kind. */
      hostInput?: "initial" | "steer";
      text: string;
      images?: readonly { mediaType: string; base64: string }[];
      /** 是否仍在流式接收增量（未完成）。 */
      streaming: boolean;
      /** Explicit terminal evidence for an interrupted assistant reply. */
      stopReason?: "aborted";
      /** Recorded ISO time from exported history or a child transcript; absent for live rows. */
      timestamp?: string;
    }
  | { kind: "thinking"; id: string; text: string; streaming: boolean; timestamp?: string }
  | { kind: "tool"; id: string; call: ToolCall; timestamp?: string };

/** 调试面板的一条原始事件日志。 */
export type EventLogEntry = {
  seq: number;
  time: string;
  type: string;
  data: unknown;
};
