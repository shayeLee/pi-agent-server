import { addUserMessage, applySseEvent, createChatState } from "./chat-state.js";
import type { ChatState } from "./chat-state.js";
import type { SseEvent, TimelineItem } from "./types.js";

export type ChatStateListener = (state: ChatState) => void;

/** Framework-neutral observable state store for reducers and SSE event consumers. */
export type ChatStore = {
  getState(): ChatState;
  applyEvent(event: SseEvent): ChatState;
  addUserMessage(text: string, messageId?: string): ChatState;
  /** Replace the visible timeline with restored session history. */
  restoreHistory(timeline: TimelineItem[]): ChatState;
  /** Set or clear the most recent chat error. */
  setError(error: string | null): ChatState;
  /** Remove a still-pending optimistic user message after a failed send. */
  rollbackUserMessage(messageId: string, error: string): ChatState;
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
    applyEvent: (event) => update(applySseEvent(state, event)),
    addUserMessage: (text, messageId) => update(addUserMessage(state, text, messageId)),
    restoreHistory: (timeline) => update({ ...state, timeline }),
    setError: (error) => update({ ...state, error }),
    rollbackUserMessage: (messageId, error) => {
      const last = state.timeline[state.timeline.length - 1];
      if (
        last?.kind !== "message" ||
        last.id !== messageId ||
        state.phase !== "queued"
      ) {
        return state;
      }
      return update({
        ...state,
        timeline: state.timeline.slice(0, -1),
        phase: "idle",
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
