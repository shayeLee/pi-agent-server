import { describe, expect, it } from "vitest";
import { createChatStore } from "../../src/client/chat-store.js";

describe("local primary submission", () => {
  it.each([false, true])("does not fabricate queue evidence (image: %s)", image => {
    const store = createChatStore();
    if (image) store.beginRequest("local");
    else store.addUserMessage("hello", "m", "local");
    expect(store.getState().phase).toBe("submitting");
    store.restoreHistory(store.getState().timeline);
    store.markDisconnected();
    for (const event of [
      { type: "queued", requestId: "foreign" },
      { type: "status", phase: "agent_start", requestId: "foreign" },
      { type: "completed", requestId: "foreign" },
    ] as const) store.applyEvent(event);
    expect(store.getState()).toMatchObject({ phase: "submitting", activeRequestId: "local" });
    store.applyEvent({ type: "queued", requestId: "local" });
    expect(store.getState().phase).toBe("queued");
    store.applyEvent({ type: "status", phase: "agent_start", requestId: "local" });
    expect(store.getState().phase).toBe("streaming");
  });
  it("ambiguous rollback removes the optimistic bubble without releasing ownership", () => {
    const store = createChatStore();
    store.addUserMessage("hello", "m", "local");
    store.rollbackUserMessage("m", "unknown", true);
    expect(store.getState()).toMatchObject({ phase: "submitting", activeRequestId: "local", timeline: [] });
    store.applyEvent({ type: "queued", requestId: "foreign" });
    expect(store.getState().activeRequestId).toBe("local");
    store.applyEvent({ type: "status", phase: "agent_start", requestId: "local" });
    expect(store.getState().phase).toBe("streaming");
  });
});
