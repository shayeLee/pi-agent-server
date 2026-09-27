// SSE event → conversation timeline state mapping. This is pure data logic with no UI framework.

import type { SseEvent, TimelineItem, ToolCall, UsageStats } from "./types.js";

/** Chat flow phase. */
export type ChatPhase = "idle" | "queued" | "streaming" | "completed" | "aborted";

/** Serializable chat state, independent of presentation frameworks. */
export type ChatState = {
  /** Timeline of messages, thinking segments, and tool calls in event order. */
  timeline: TimelineItem[];
  phase: ChatPhase;
  /** Display message from the most recent error event. */
  error: string | null;
  /** Current/most recent turn statistics from a usage event. */
  stats: UsageStats | null;
};

export function createChatState(): ChatState {
  return { timeline: [], phase: "idle", error: null, stats: null };
}

/** Append a user message and enter queued phase until the server responds. */
export function addUserMessage(state: ChatState, text: string, messageId?: string): ChatState {
  const message: TimelineItem = {
    kind: "message",
    id: messageId ?? `user-${state.timeline.length}`,
    role: "user",
    text,
    streaming: false,
  };
  return {
    ...state,
    timeline: [...state.timeline, message],
    phase: "queued",
    error: null,
  };
}

/** Map one SSE event to a new ChatState without mutating the previous state. */
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
    case "model_failback":
      // Failback metadata is informational and does not change conversation state.
      return state;
    case "completed":
      return closeCurrentAssistant({ ...state, phase: "completed", error: null });
    case "aborted":
      return closeCurrentAssistant({ ...state, phase: "aborted" });
    case "error":
      // An error ends this answer; subsequent text_delta starts a new message.
      return closeCurrentAssistant({ ...state, phase: "idle", error: event.message });
    default:
      // Ignore future or malformed events without corrupting the current state.
      return state;
  }
}

/** Append text to the current streaming assistant message, or start a new one. */
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

/** Append text to the current streaming thinking segment, or start a new one. */
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

/** Close the currently streaming thinking segment. */
function closeCurrentThinking(timeline: TimelineItem[]): TimelineItem[] {
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "thinking" && last.streaming) {
    return [...timeline.slice(0, -1), { ...last, streaming: false }];
  }
  return timeline;
}

/** Close the currently streaming assistant message at terminal events. */
function closeCurrentAssistant(state: ChatState): ChatState {
  const timeline = closeCurrentThinking(state.timeline);
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "message" && last.streaming) {
    return { ...state, timeline: [...timeline.slice(0, -1), { ...last, streaming: false }] };
  }
  return { ...state, timeline };
}

/** A tool start interrupts streaming assistant text and appends a timeline item. */
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

/** Update the most recent timeline tool item with a matching toolCallId. */
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
    if (item?.kind === "tool" && item.call.toolCallId === toolCallId) return i;
  }
  return -1;
}
