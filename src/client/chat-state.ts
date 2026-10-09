// SSE event → conversation timeline state mapping. This is pure data logic with no UI framework.

import type { SseEvent, TimelineItem, ToolCall, UsageStats } from "./types.js";
import { toolDurationMs } from "../shared/tool-duration.js";

/** Chat flow phase. */
export type ChatPhase = "idle" | "queued" | "streaming" | "completed" | "aborted";

/** Serializable chat state, independent of presentation frameworks. */
export type ChatState = {
  /** Timeline of messages, thinking segments, and tool calls in event order. */
  timeline: TimelineItem[];
  phase: ChatPhase;
  /** Request owning queued/streaming lifecycle. Legacy events without IDs retain their behavior. */
  activeRequestId?: string | null;
  /** Display message from the most recent error event. */
  error: string | null;
  /** Current/most recent turn statistics from a usage event. */
  stats: UsageStats | null;
  /** Ephemeral receipt clock; never restored from history. */
  modelOutput?: (import("./types.js").ModelOutputProgress & { receivedAt: number }) | null;
  /** Only observed tool_start lifecycle for the active request, not historical timeline cards. */
  activeToolCallIds?: string[];
};

export function createChatState(): ChatState {
  return { timeline: [], phase: "idle", error: null, stats: null };
}

/** Append a user message and enter queued phase until the server responds. */
export function addUserMessage(state: ChatState, text: string, messageId?: string, requestId?: string): ChatState {
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
    activeRequestId: requestId ?? null,
    modelOutput: null,
    activeToolCallIds: [],
    error: null,
  };
}

/** Notifications are display-only. Missing IDs retain the legacy session-stream contract.
 * A new lifecycle may claim an idle/terminal state, but cannot steal an active request. */
export function ownsSseEvent(state: ChatState, event: SseEvent): boolean {
  if (event.type === "notification") return false;
  if (!event.requestId || !state.activeRequestId) return true;
  if (event.requestId === state.activeRequestId) return true;
  return state.phase !== "queued" && state.phase !== "streaming" &&
    (event.type === "status" || event.type === "queued" || event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_start");
}

/** Counts are snapshots, never increments. Replayed/stale snapshots cannot roll back a session. */
export function mergeExecution(previous: import("./types.js").ExecutionSnapshot | null | undefined, incoming: import("./types.js").ExecutionSnapshot | null | undefined) {
  if (incoming === undefined) return previous;
  if (previous && incoming && previous.recordedLoops !== null && previous.recordedTurns !== null &&
      incoming.recordedLoops !== null && incoming.recordedTurns !== null &&
      (incoming.recordedLoops < previous.recordedLoops || incoming.recordedTurns < previous.recordedTurns)) return previous;
  return incoming;
}

/** Map one SSE event to a new ChatState without mutating the previous state. */
export function applySseEvent(state: ChatState, event: SseEvent, now: () => number = () => performance.now()): ChatState {
  if (event.type !== "notification") {
    if (!ownsSseEvent(state, event)) {
      // Record a foreign failure, without ending the active answer or clearing its progress.
      return event.type === "error" ? { ...state, error: event.message } : state;
    }
    if (event.requestId && (event.type === "status" || event.type === "queued" ||
        event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_start")) {
      state = { ...state, activeRequestId: event.requestId };
    }
  }
  switch (event.type) {
    case "notification": {
      const { type: _type, ...notification } = event;
      const item: TimelineItem = { ...notification, kind: "notification", id: `notification:${event.notificationId}` };
      const exists = state.timeline.some(row => row.id === item.id);
      return { ...state, timeline: exists ? state.timeline.map(row => row.id === item.id ? item : row) : [...state.timeline, item] };
    }
    case "steering_consumed": {
      const message = event.message;
      // Legacy acknowledgements only clear controller pending state, never invent a bubble.
      if (!message || typeof message.sourceId !== "string" || !message.sourceId || typeof message.text !== "string") return state;
      const id = `history-message:${message.sourceId}`;
      if (state.timeline.some(row => row.id === id)) return state;
      const timeline = state.timeline.map(row =>
        (row.kind === "thinking" || (row.kind === "message" && row.role === "assistant")) && row.streaming
          ? { ...row, streaming: false } : row);
      return { ...state, timeline: [...timeline, { kind: "message", id,
        role: "user", text: message.text, streaming: false,
        ...(message.images?.length ? { images: message.images } : {}) }] };
    }
    case "model_output_progress":
      return { ...state, modelOutput: !event.replay && event.phase === "delta"
        ? { ...event, receivedAt: now() - Math.max(0, event.activityAgeMs ?? 0) } : null };
    case "text_delta":
      return appendAssistantText(state, event.text);
    case "thinking_delta":
      return appendThinking(state, event.text);
    case "tool_start":
      return appendToolCall({ ...state, activeToolCallIds: [...new Set([...(state.activeToolCallIds ?? []), event.toolCallId])] }, {
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
      return upsertToolCall({ ...state, activeToolCallIds: state.activeToolCallIds?.filter(id => id !== event.toolCallId) }, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
        ...(toolDurationMs(event.durationMs) !== undefined ? { durationMs: toolDurationMs(event.durationMs) } : {}),
        done: true,
      });
    case "status": {
      const stats = event.phase === "agent_start" && state.stats ? { ...state.stats, lastResponse: null, context: null } : state.stats;
      return { ...state, activeToolCallIds: event.phase === "agent_start" ? [] : state.activeToolCallIds, modelOutput: event.phase === "agent_start" ? null : state.modelOutput, phase: "streaming", stats: event.execution === undefined ? stats : {
        durationMs: NaN, ttftMs: NaN, promptTokens: null, completionTokens: null, totalTokens: null,
        ...stats, execution: mergeExecution(stats?.execution, event.execution),
      } };
    }
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
          ...(event.lastResponse !== undefined ? { lastResponse: event.lastResponse } : {}),
          ...(event.sessionTotals !== undefined ? { sessionTotals: event.sessionTotals } : {}),
          ...(event.context !== undefined ? { context: event.context } : {}),
          ...(event.execution !== undefined || state.stats?.execution !== undefined ? { execution: mergeExecution(state.stats?.execution, event.execution) } : {}),
        },
      };
    case "model_failback":
      // Failback metadata is informational and does not change conversation state.
      return state;
    case "completed":
      return closeCurrentAssistant({ ...state, modelOutput: null, activeToolCallIds: [], phase: "completed", error: null });
    case "aborted":
      return closeCurrentAssistant({ ...state, modelOutput: null, activeToolCallIds: [], phase: "aborted" });
    case "error":
      // An error ends this answer; subsequent text_delta starts a new message.
      return closeCurrentAssistant({ ...state, modelOutput: null, activeToolCallIds: [], phase: "idle", error: event.message });
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
