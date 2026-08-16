// SSE 事件 → 聊天 UI 状态的纯函数映射。
// 不依赖 DOM/网络；全部通过 createChatState/applySseEvent/addUserMessage 演进状态。

import type { ChatMessage, SseEvent, ToolCall } from "../types.js";

/** 聊天流程阶段。 */
export type ChatPhase = "idle" | "queued" | "streaming" | "completed" | "aborted";

/** 聊天区 UI 状态（纯数据，可序列化）。 */
export type ChatState = {
  messages: ChatMessage[];
  toolCalls: ToolCall[];
  phase: ChatPhase;
  /** 最近一次 error 事件的展示消息。 */
  error: string | null;
};

export function createChatState(): ChatState {
  return { messages: [], toolCalls: [], phase: "idle", error: null };
}

/**
 * 追加用户消息。
 * 同时把会话标记为「本次回答已结束」：下一条 assistant 事件会另起新消息。
 * （SSE 流里没有用户消息事件，用户消息由前端发送时直接入列。）
 */
export function addUserMessage(state: ChatState, text: string, messageId?: string): ChatState {
  const message: ChatMessage = {
    id: messageId ?? `user-${state.messages.length}`,
    role: "user",
    text,
  };
  // 发送后进入「等待服务端确认」：禁止再次发送（Composer 据此显示 steer/abort），
  // 直到收到 queued/streaming/completed 事件，或 sendMessage 失败回滚为 idle。
  return {
    ...state,
    messages: [...state.messages, message],
    phase: "queued",
    error: null,
  };
}

/** 把一条 SSE 事件映射到新的 ChatState（不改动原状态）。 */
export function applySseEvent(state: ChatState, event: SseEvent): ChatState {
  switch (event.type) {
    case "text_delta":
      return appendAssistantText(state, event.text);
    case "tool_start":
      return upsertToolCall(state, {
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
    case "completed":
      return { ...state, phase: "completed", error: null };
    case "aborted":
      return { ...state, phase: "aborted" };
    case "error":
      // error 视为本次回答终止：后续 text_delta 另起新消息。
      return { ...state, phase: "idle", error: event.message };
  }
}

/** text_delta：追加到当前 assistant 消息；没有则新开一条。 */
function appendAssistantText(state: ChatState, text: string): ChatState {
  const last = state.messages[state.messages.length - 1];
  if (state.phase === "streaming" && last && last.role === "assistant") {
    const messages = state.messages.slice(0, -1);
    messages.push({ ...last, text: last.text + text });
    return { ...state, messages, phase: "streaming" };
  }
  const message: ChatMessage = {
    id: `assistant-${state.messages.length}`,
    role: "assistant",
    text,
  };
  return { ...state, messages: [...state.messages, message], phase: "streaming" };
}

/** 按 toolCallId 合并一条工具调用记录；未知 id 则追加新卡片。 */
function upsertToolCall(
  state: ChatState,
  patch: Partial<ToolCall> & { toolCallId: string; toolName: string },
): ChatState {
  const idx = state.toolCalls.findIndex((t) => t.toolCallId === patch.toolCallId);
  const merged: ToolCall = {
    // 默认值（toolCallId/toolName 由 patch 提供）
    args: undefined,
    partialResult: undefined,
    result: undefined,
    isError: false,
    done: false,
    ...(idx >= 0 ? state.toolCalls[idx] : {}),
    ...patch,
  };
  const toolCalls =
    idx >= 0
      ? state.toolCalls.map((t, i) => (i === idx ? merged : t))
      : [...state.toolCalls, merged];
  return { ...state, toolCalls, phase: "streaming" };
}