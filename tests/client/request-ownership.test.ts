import { describe, it, expect } from "vitest";
import { addUserMessage, applySseEvent, createChatState } from "../../src/client/chat-state.js";
import type { SseEvent } from "../../src/client/types.js";

describe("request-owned chat lifecycle", () => {
  it("foreign notification admission failures cannot end the active user answer", () => {
    let state = addUserMessage(createChatState(), "hello", "user-card", "user");
    state = applySseEvent(state, { type: "status", phase: "agent_start", requestId: "user" });
    state = applySseEvent(state, { type: "text_delta", text: "answer", requestId: "user" });
    state = { ...state, modelOutput: { phase: "delta", receivedAt: 10 } as any, activeToolCallIds: ["tool"] };
    for (const event of [
      { type: "error", message: "notification rejected", requestId: "notice" },
      { type: "completed", requestId: "notice" }, { type: "aborted", requestId: "old" },
      { type: "queued", position: 1, requestId: "old" },
      { type: "status", phase: "agent_start", requestId: "old" },
      { type: "text_delta", text: "wrong", requestId: "old" },
      { type: "thinking_delta", text: "wrong", requestId: "old" },
      { type: "tool_start", toolCallId: "wrong", toolName: "test", args: {}, requestId: "old" },
    ] as SseEvent[]) {
      const next = applySseEvent(state, event);
      expect(next.phase).toBe("streaming"); expect(next.timeline).toBe(state.timeline);
      expect(next.modelOutput).toBe(state.modelOutput); expect(next.activeToolCallIds).toEqual(["tool"]);
      state = next;
    }
    state = applySseEvent(state, { type: "text_delta", text: " continued", requestId: "user" });
    expect(state.timeline.at(-1)).toMatchObject({ text: "answer continued", streaming: true });
    state = applySseEvent(state, { type: "completed", requestId: "user" });
    expect(state.phase).toBe("completed"); expect(state.modelOutput).toBeNull();
    state = applySseEvent(state, { type: "status", phase: "agent_start", requestId: "new-notice" });
    expect(state.activeRequestId).toBe("new-notice"); expect(state.phase).toBe("streaming");
  });
  it("legacy no-ID events work, while no-ID notifications always remain display-only", () => {
    let state = applySseEvent(createChatState(), { type: "text_delta", text: "legacy" });
    state = applySseEvent(state, { type: "notification", version: 1, notificationId: "id", runIds: [], text: "notice", entryId: "entry", timestamp: "now" } as SseEvent);
    expect(state.phase).toBe("streaming");
    state = applySseEvent(state, { type: "error", message: "legacy failure" });
    expect(state.phase).toBe("idle");
  });
});
