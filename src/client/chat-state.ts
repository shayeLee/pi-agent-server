// SSE event → conversation timeline state mapping. This is pure data logic with no UI framework.

import type { SseEvent, TimelineItem, ToolCall, UsageStats } from "./types.js";
import { toolDurationMs } from "../shared/tool-duration.js";
import { NESTED_CALL_MAX, NESTED_ERROR_MAX_CHARS, type NestedToolCall, type NestedToolCalls } from "../shared/nested-tool-calls.js";

/** Chat flow phase. */
export type ChatPhase = "idle" | "submitting" | "queued" | "streaming" | "completed" | "aborted";

/** Serializable chat state, independent of presentation frameworks. */
export type ChatState = {
  /** Timeline of messages, thinking segments, and tool calls in event order. */
  timeline: TimelineItem[];
  phase: ChatPhase;
  /** Request owning submitting/queued/streaming lifecycle. Legacy events without IDs retain their behavior. */
  activeRequestId?: string | null;
  /** Previously owned requests cannot reclaim compaction after a newer request finishes. */
  retiredRequestIds?: string[];
  /** Display message from the most recent error event. */
  error: string | null;
  /** Current/most recent turn statistics from a usage event. */
  stats: UsageStats | null;
  /** Ephemeral receipt clock; never restored from history. */
  modelOutput?: (import("./types.js").ModelOutputProgress & { receivedAt: number }) | null;
  /** Current prompt so far: the model call in progress (1-based) and tokens of completed calls. Live only. */
  runProgress?: { calls: number; promptTokens: number | null } | null;
  /** Only observed tool_start lifecycle for the active request, not historical timeline cards. */
  activeToolCallIds?: string[];
  compaction?: import("../shared/events.js").CompactionState | null;
  /**
   * The dialog an extension command is waiting on. `closed: "answered"` keeps it on screen, marked as
   * answered elsewhere, until the command's output arrives; cancelled or timed-out questions just go.
   */
  commandPrompt?: { prompt: import("../shared/commands.js").CommandPrompt; closed?: "answered" } | null;
};

export function createChatState(): ChatState {
  return { timeline: [], phase: "idle", error: null, stats: null };
}

/** Append a local user message; only server evidence can establish queued/running state. */
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
    phase: "submitting",
    activeRequestId: requestId ?? null,
    retiredRequestIds: retireRequest(state, requestId),
    compaction: null,
    modelOutput: null,
    runProgress: null,
    activeToolCallIds: [],
    error: null,
  };
}

/** Notifications are display-only. Missing IDs retain the legacy session-stream contract.
 * A new lifecycle may claim an idle/terminal state, but cannot steal an active request. */
export function ownsSseEvent(state: ChatState, event: SseEvent): boolean {
  if (event.type === "notification" || event.type === "command_output" || event.type === "command_prompt" || event.type === "command_prompt_closed") return false;
  if ((event.type === "compaction_start" || event.type === "compaction_end") && event.requestId &&
      state.retiredRequestIds?.includes(event.requestId)) return false;
  if (!event.requestId || !state.activeRequestId) return true;
  if (event.requestId === state.activeRequestId) return true;
  return state.phase !== "submitting" && state.phase !== "queued" && state.phase !== "streaming" &&
    (event.type === "status" || event.type === "queued" || event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_start" || event.type === "compaction_start");
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
  if (event.type !== "notification" && event.type !== "command_output" && event.type !== "command_prompt" && event.type !== "command_prompt_closed") {
    if (!ownsSseEvent(state, event)) {
      // Record a foreign failure, without ending the active answer or clearing its progress.
      return event.type === "error" ? { ...state, error: event.message } : state;
    }
    if (event.requestId && (event.type === "status" || event.type === "queued" ||
        event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_start" || event.type === "compaction_start")) {
      state = { ...state, activeRequestId: event.requestId, retiredRequestIds: retireRequest(state, event.requestId),
        ...(event.requestId !== state.activeRequestId && event.requestId !== state.compaction?.requestId ? { compaction: null } : {}) };
    }
  }
  if ((event.type === "tool_start" || event.type === "tool_update" || event.type === "tool_end") && event.parentToolCallId) {
    const nested = applyNestedToolEvent(state, event, event.parentToolCallId);
    if (nested) return nested;
  }
  switch (event.type) {
    case "notification": {
      const { type: _type, ...notification } = event;
      const item: TimelineItem = { ...notification, kind: "notification", id: `notification:${event.notificationId}` };
      const exists = state.timeline.some(row => row.id === item.id);
      return { ...state, timeline: exists ? state.timeline.map(row => row.id === item.id ? item : row) : [...state.timeline, item] };
    }
    case "command_output": {
      const { type: _type, ...record } = event;
      const item: TimelineItem = { ...record, kind: "command", id: `command:${event.entryId}` };
      const exists = state.timeline.some(row => row.id === item.id);
      // The command finished: whatever it asked is settled.
      return { ...state, commandPrompt: null, timeline: exists ? state.timeline.map(row => row.id === item.id ? item : row) : [...state.timeline, item] };
    }
    case "command_prompt":
      return { ...state, commandPrompt: { prompt: event.prompt } };
    case "command_prompt_closed": {
      const current = state.commandPrompt;
      if (!current || current.prompt.promptId !== event.promptId) return state;
      return { ...state, commandPrompt: event.reason === "answered" ? { ...current, closed: "answered" } : null };
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
    case "compaction_start":
      return closeCurrentAssistant({ ...state, phase: "streaming", modelOutput: null,
        compaction: { status: event.replay ? "unknown" : "running", reason: event.reason,
          ...(event.requestId ? { requestId: event.requestId } : {}) } });
    case "compaction_end":
      return { ...state, ...(!state.activeRequestId && event.requestId ? { activeRequestId: event.requestId } : {}), compaction: { status: event.outcome, reason: event.reason,
        ...(event.requestId ? { requestId: event.requestId } : {}), willRetry: event.willRetry,
        ...(validTokenCount(event.tokensBefore) ? { tokensBefore: event.tokensBefore } : {}),
        ...(validTokenCount(event.tokensAfter) ? { tokensAfter: event.tokensAfter } : {}) } };
    case "model_output_progress":
      return { ...state, runProgress: { calls: event.ordinal, promptTokens: event.promptTokens ?? null },
        modelOutput: !event.replay && event.phase === "delta"
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
      }, call => call.nested ? { nested: settleNestedCalls(call.nested) } : {});
    case "status": {
      // The context keeps its last measurement while a run goes on; the run's usage event replaces it.
      const stats = event.phase === "agent_start" && state.stats ? { ...state.stats, lastResponse: null } : state.stats;
      return { ...state, activeToolCallIds: event.phase === "agent_start" ? [] : state.activeToolCallIds, modelOutput: event.phase === "agent_start" ? null : state.modelOutput,
        ...(event.phase === "agent_start" ? { runProgress: null } : {}), phase: "streaming", stats: event.execution === undefined ? stats : {
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
          ...(event.currentPrompt !== undefined ? { currentPrompt: event.currentPrompt } : {}),
          ...(event.subagentTotals !== undefined ? { subagentTotals: event.subagentTotals } : {}),
          ...(event.branchTotals !== undefined ? { branchTotals: event.branchTotals } : {}),
          ...(event.subagentAllTotals !== undefined ? { subagentAllTotals: event.subagentAllTotals } : {}),
          ...(event.execution !== undefined || state.stats?.execution !== undefined ? { execution: mergeExecution(state.stats?.execution, event.execution) } : {}),
        },
      };
    case "model_failback":
      // Failback metadata is informational and does not change conversation state.
      return state;
    case "completed":
      return closeCurrentAssistant({ ...state, compaction: finishCompaction(state.compaction, "unknown"), modelOutput: null, activeToolCallIds: [], phase: "completed", error: null });
    case "aborted":
      return closeCurrentAssistant({ ...state, compaction: finishCompaction(state.compaction, "aborted"), modelOutput: null, activeToolCallIds: [], phase: "aborted" }, true);
    case "error":
      // An error ends this answer; subsequent text_delta starts a new message.
      return closeCurrentAssistant({ ...state, compaction: finishCompaction(state.compaction, "failed"), modelOutput: null, activeToolCallIds: [], phase: "idle", error: event.message });
    default:
      // Ignore future or malformed events without corrupting the current state.
      return state;
  }
}

export function retireRequest(state: ChatState, requestId?: string): string[] | undefined {
  return state.activeRequestId && state.activeRequestId !== requestId
    ? [...new Set([...(state.retiredRequestIds ?? []), state.activeRequestId])]
    : state.retiredRequestIds;
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Missing explicit end is never evidence of success. */
export function finishCompaction(compaction: ChatState["compaction"], status: "unknown" | "failed" | "aborted"): ChatState["compaction"] {
  return compaction?.status === "running" ? { ...compaction, status } : compaction;
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

/** Close all streaming assistant messages and thinking segments at terminal events. */
function closeCurrentAssistant(state: ChatState, aborted = false): ChatState {
  const timeline = state.timeline.map(item =>
    ((item.kind === "thinking" || (item.kind === "message" && item.role === "assistant")) && item.streaming)
      ? { ...item, streaming: false, ...(aborted && item.kind === "message" ? { stopReason: "aborted" as const } : {}) } : item,
  );
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
  derive?: (call: ToolCall) => Partial<ToolCall>,
): ChatState {
  const idx = findLastToolIndex(state.timeline, patch.toolCallId);
  if (idx < 0) return appendToolCall(state, patch);
  const prev = state.timeline[idx] as Extract<TimelineItem, { kind: "tool" }>;
  const merged: ToolCall = { ...prev.call, ...patch, ...derive?.(prev.call) };
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

type ToolEvent = Extract<SseEvent, { type: "tool_start" | "tool_update" | "tool_end" }>;

/**
 * A nested call only updates the card of the model-issued call it belongs to. Calls made by
 * nested calls name a nested id as their parent, so the owner is the card listing that id.
 * Returns undefined when no card owns the parent, and the event then gets its own card.
 */
function applyNestedToolEvent(state: ChatState, event: ToolEvent, parentId: string): ChatState | undefined {
  let index = -1;
  for (let i = state.timeline.length - 1; i >= 0 && index < 0; i--) {
    const item = state.timeline[i];
    if (item?.kind === "tool" && (item.call.toolCallId === parentId || item.call.nested?.calls.some(call => call.id === parentId))) index = i;
  }
  if (index < 0) return undefined;
  const owner = state.timeline[index] as Extract<TimelineItem, { kind: "tool" }>;
  const nested = owner.call.nested ?? { calls: [], complete: true };
  const next = updateNestedCalls(nested, event);
  if (next === nested) return state;
  const timeline = state.timeline.map((item, i) => i === index ? { ...owner, call: { ...owner.call, nested: next } } : item);
  return { ...state, timeline };
}

function updateNestedCalls(nested: NestedToolCalls, event: ToolEvent): NestedToolCalls {
  const position = nested.calls.findIndex(call => call.id === event.toolCallId);
  if (event.type === "tool_start") {
    if (position >= 0) return nested;
    if (nested.calls.length >= NESTED_CALL_MAX) return nested.complete ? { ...nested, complete: false } : nested;
    return { ...nested, calls: [...nested.calls, { id: event.toolCallId, name: event.toolName, status: "running", arguments: event.args }] };
  }
  if (event.type === "tool_update" || position < 0) return nested;
  const durationMs = toolDurationMs(event.durationMs);
  const error = event.isError ? resultErrorText(event.result) : "";
  const ended: NestedToolCall = { ...nested.calls[position]!, status: event.isError ? "error" : "ok",
    ...(typeof durationMs === "number" ? { durationMs } : {}), ...(error ? { error } : {}) };
  return { ...nested, calls: nested.calls.map((call, i) => i === position ? ended : call) };
}

/** When the owning call ends, calls still running will not report again. */
function settleNestedCalls(nested: NestedToolCalls): NestedToolCalls {
  if (!nested.calls.some(call => call.status === "running")) return nested;
  return { complete: false, calls: nested.calls.map(call => call.status === "running" ? { ...call, status: "unfinished" } : call) };
}

function resultErrorText(result: unknown): string {
  if (typeof result === "string") return result.slice(0, NESTED_ERROR_MAX_CHARS);
  const content = result && typeof result === "object" && "content" in result && Array.isArray(result.content) ? result.content : [];
  return content
    .map((block: unknown) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? block.text : "")
    .filter(Boolean).join("\n").slice(0, NESTED_ERROR_MAX_CHARS);
}
