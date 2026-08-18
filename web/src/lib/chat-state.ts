// SSE 事件 → 聊天 UI 状态的纯函数映射。
// 不依赖 DOM/网络；全部通过 createChatState/applySseEvent/addUserMessage 演进状态。
// 核心模型是「时间线」（timeline）：消息、思考与工具调用按 SSE 事件到达顺序交错排列。

import type { SseEvent, TimelineItem, ToolCall, UsageStats } from "../types.js";

/** 聊天流程阶段。 */
export type ChatPhase = "idle" | "queued" | "streaming" | "completed" | "aborted";

/** 聊天区 UI 状态（纯数据，可序列化）。 */
export type ChatState = {
  /** 按时间顺序的消息 + 思考 + 工具调用条目。 */
  timeline: TimelineItem[];
  phase: ChatPhase;
  /** 最近一次 error 事件的展示消息。 */
  error: string | null;
  /** 当前/最近一次 turn 的统计（来自 usage SSE 事件）。 */
  stats: UsageStats | null;
};

export function createChatState(): ChatState {
  return { timeline: [], phase: "idle", error: null, stats: null };
}

/**
 * 追加用户消息。
 * 同时把会话标记为「本次回答已结束」：下一条 assistant 事件会另起新消息。
 * （SSE 流里没有用户消息事件，用户消息由前端发送时直接入列。）
 */
export function addUserMessage(state: ChatState, text: string, messageId?: string): ChatState {
  const message: TimelineItem = {
    kind: "message",
    id: messageId ?? `user-${state.timeline.length}`,
    role: "user",
    text,
    streaming: false,
  };
  // 发送后进入「等待服务端确认」：禁止再次发送（Composer 据此显示 steer/abort），
  // 直到收到 queued/streaming/completed 事件，或 sendMessage 失败回滚为 idle。
  return {
    ...state,
    timeline: [...state.timeline, message],
    phase: "queued",
    error: null,
  };
}

/** 把一条 SSE 事件映射到新的 ChatState（不改动原状态）。 */
export function applySseEvent(state: ChatState, event: SseEvent): ChatState {
  switch (event.type) {
    case "text_delta":
      return appendAssistantText(state, event.text);
    case "thinking_delta":
      return appendThinking(state, event.text);
    case "tool_start":
      return appendToolCall(state, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    case "tool_update":
      return upsertToolCall(state, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      });
    case "tool_end":
      return upsertToolCall(state, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
        done: true,
      });
    case "status":
      return { ...state, phase: "streaming" };
    case "queued":
      return { ...state, phase: "queued" };
    case "usage":
      return {
        ...state,
        stats: {
          durationMs: event.durationMs,
          ttftMs: event.ttftMs,
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
        },
      };
    case "completed":
      return closeCurrentAssistant({ ...state, phase: "completed", error: null });
    case "aborted":
      return closeCurrentAssistant({ ...state, phase: "aborted" });
    case "error":
      // error 视为本次回答终止：后续 text_delta 另起新消息。
      return closeCurrentAssistant({ ...state, phase: "idle", error: event.message });
  }
}

/** text_delta：追加到当前 streaming 的 assistant 消息；没有则新开一条。 */
function appendAssistantText(state: ChatState, text: string): ChatState {
  let timeline = closeCurrentThinking(state.timeline);
  const last = timeline[timeline.length - 1];
  if (
    last &&
    last.kind === "message" &&
    last.role === "assistant" &&
    last.streaming &&
    state.phase === "streaming"
  ) {
    timeline = timeline.slice(0, -1);
    timeline.push({ ...last, text: last.text + text });
    return { ...state, timeline, phase: "streaming" };
  }
  const message: TimelineItem = {
    kind: "message",
    id: `assistant-${timeline.length}`,
    role: "assistant",
    text,
    streaming: true,
  };
  return { ...state, timeline: [...timeline, message], phase: "streaming" };
}

/** thinking_delta：追加到当前 streaming 的思考条目；没有则新开一条。 */
function appendThinking(state: ChatState, text: string): ChatState {
  const last = state.timeline[state.timeline.length - 1];
  if (last && last.kind === "thinking" && last.streaming) {
    const timeline = state.timeline.slice(0, -1);
    timeline.push({ ...last, text: last.text + text });
    return { ...state, timeline, phase: "streaming" };
  }
  const thinking: TimelineItem = {
    kind: "thinking",
    id: `thinking-${state.timeline.length}`,
    text,
    streaming: true,
  };
  return { ...state, timeline: [...state.timeline, thinking], phase: "streaming" };
}

/** 收到 assistant 文本/工具/终态时，关闭当前思考条目的 streaming 标记。 */
function closeCurrentThinking(timeline: TimelineItem[]): TimelineItem[] {
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "thinking" && last.streaming) {
    return [...timeline.slice(0, -1), { ...last, streaming: false }];
  }
  return timeline;
}

/** 终态/错误时关闭当前 assistant 消息的 streaming。 */
function closeCurrentAssistant(state: ChatState): ChatState {
  const timeline = closeCurrentThinking(state.timeline);
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "message" && last.streaming) {
    return { ...state, timeline: [...timeline.slice(0, -1), { ...last, streaming: false }] };
  }
  return { ...state, timeline };
}

/**
 * tool_start：关闭当前 streaming 的 assistant 消息（工具调用「打断」文本流），
 * 再追加一个新的工具调用条目——保证时间线渲染顺序正确。
 */
function appendToolCall(
  state: ChatState,
  patch: Partial<ToolCall> & { toolCallId: string; toolName: string },
): ChatState {
  let timeline = closeCurrentThinking(state.timeline);
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "message" && last.streaming) {
    timeline = [...timeline.slice(0, -1), { ...last, streaming: false }];
  }
  const call: ToolCall = {
    args: undefined,
    partialResult: undefined,
    result: undefined,
    isError: false,
    done: false,
    ...patch,
  };
  timeline = [...timeline, { kind: "tool", id: patch.toolCallId, call }];
  return { ...state, timeline, phase: "streaming" };
}

/** 按 toolCallId 更新时间线上最近一条工具调用（tool_update/tool_end）。 */
function upsertToolCall(
  state: ChatState,
  patch: Partial<ToolCall> & { toolCallId: string; toolName: string },
): ChatState {
  const idx = findLastToolIndex(state.timeline, patch.toolCallId);
  if (idx < 0) return appendToolCall(state, patch);
  const prev = state.timeline[idx] as Extract<TimelineItem, { kind: "tool" }>;
  const merged: ToolCall = { ...prev.call, ...patch };
  const timeline = state.timeline.map((item, i) =>
    i === idx ? { kind: "tool" as const, id: patch.toolCallId, call: merged } : item,
  );
  return { ...state, timeline, phase: "streaming" };
}

function findLastToolIndex(timeline: TimelineItem[], toolCallId: string): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind === "tool" && item.call.toolCallId === toolCallId) return i;
  }
  return -1;
}
