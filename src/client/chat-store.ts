import { addUserMessage, applySseEvent, createChatState, mergeExecution, finishCompaction, retireRequest } from "./chat-state.js";
import type { ChatState } from "./chat-state.js";
import type { SseEvent, TimelineItem } from "./types.js";

export type ChatStateListener = (state: ChatState) => void;

/** Framework-neutral observable state store for reducers and SSE event consumers. */
export type ChatStore = {
  getState(): ChatState;
  clearModelOutput(): ChatState;
  /** Clear transient output and mark running compaction as unconfirmed after connection loss. */
  markDisconnected(): ChatState;
  applyEvent(event: SseEvent): ChatState;
  addUserMessage(text: string, messageId?: string, requestId?: string): ChatState;
  beginRequest(requestId: string): ChatState;
  /** Replace the visible timeline with restored session history. */
  restoreHistory(timeline: TimelineItem[]): ChatState;
  restoreCompaction(compaction: ChatState["compaction"]): ChatState;
  /** The open extension-command question read on (re)connect; null when there is none. */
  restoreCommandPrompt(prompt: import("../shared/commands.js").CommandPrompt | null): ChatState;
  restoreExecution(execution: import("./types.js").ExecutionSnapshot | null | undefined): ChatState;
  /** Set or clear the most recent chat error. */
  setError(error: string | null): ChatState;
  /** Remove a still-pending optimistic user message after a failed send. */
  rollbackUserMessage(messageId: string, error: string, preserveOwnership?: boolean): ChatState;
  reset(): ChatState;
  subscribe(listener: ChatStateListener, options?: { emitCurrent?: boolean }): () => void;
};

/**
 * Create a small synchronous store around the pure chat reducer.
 * Network/session orchestration remains with the host: pass SSE events to applyEvent.
 */
export function createChatStore(initialState: ChatState = createChatState()): ChatStore {
  let state = initialState;
  const listeners = new Set<ChatStateListener>();

  function update(nextState: ChatState): ChatState {
    state = nextState;
    for (const listener of [...listeners]) listener(state);
    return state;
  }

  return {
    getState: () => state,
    clearModelOutput: () => update({ ...state, modelOutput: null }),
    markDisconnected: () => update({ ...state, modelOutput: null, compaction: finishCompaction(state.compaction, "unknown") }),
    applyEvent: (event) => update(applySseEvent(state, event)),
    addUserMessage: (text, messageId, requestId) => update(addUserMessage(state, text, messageId, requestId)),
    beginRequest: (requestId) => update({ ...state, activeRequestId: requestId, retiredRequestIds: retireRequest(state, requestId), phase: "submitting", compaction: null, modelOutput: null, activeToolCallIds: [] }),
    restoreCommandPrompt: (prompt) => {
      const current = state.commandPrompt;
      if (!prompt) return current && !current.closed ? update({ ...state, commandPrompt: null }) : state;
      return current?.prompt.promptId === prompt.promptId ? state : update({ ...state, commandPrompt: { prompt } });
    },
    restoreCompaction: (compaction) => compaction === undefined ? state : update({ ...state,
      compaction: finishCompaction(compaction, "unknown"),
      ...(compaction?.status === "running" && compaction.requestId ? { activeRequestId: compaction.requestId } : {}) }),
    restoreExecution: (execution) => execution === undefined ? state : update({ ...state, stats: {
      durationMs: NaN, ttftMs: NaN, promptTokens: null, completionTokens: null, totalTokens: null,
      ...state.stats, execution: mergeExecution(state.stats?.execution, execution),
    } }),
    restoreHistory: (timeline) => update({ ...state, modelOutput: null, compaction: finishCompaction(state.compaction, "unknown"), activeToolCallIds: [], timeline }),
    setError: (error) => update({ ...state, error, compaction: error ? finishCompaction(state.compaction, "unknown") : state.compaction, modelOutput: error ? null : state.modelOutput }),
    rollbackUserMessage: (messageId, error, preserveOwnership = false) => {
      const last = state.timeline[state.timeline.length - 1];
      if (
        last?.kind !== "message" ||
        last.id !== messageId ||
        (state.phase !== "queued" && state.phase !== "submitting")
      ) {
        return state;
      }
      return update({
        ...state,
        timeline: state.timeline.slice(0, -1),
        phase: preserveOwnership ? "submitting" : "idle",
        activeRequestId: preserveOwnership ? state.activeRequestId : null,
        error,
      });
    },
    reset: () => update(createChatState()),
    subscribe(listener, options) {
      listeners.add(listener);
      if (options?.emitCurrent) listener(state);
      return () => listeners.delete(listener);
    },
  };
}
