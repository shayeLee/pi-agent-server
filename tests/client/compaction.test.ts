import { describe, expect, it } from "vitest";
import { applySseEvent, createChatState } from "../../src/client/chat-state.js";
import { createChatStore } from "../../src/client/chat-store.js";
import { SessionEventBus } from "../../src/runtime/session-event-bus.js";
import type { SseEvent } from "../../src/shared/events.js";

const start = (requestId = "r1", replay = false): SseEvent => ({ type: "compaction_start", reason: "threshold", requestId, replay });
const end: SseEvent = { type: "compaction_end", reason: "threshold", outcome: "succeeded", willRetry: true, tokensBefore: 10, tokensAfter: 5, requestId: "r1" };

describe("compaction chat state", () => {
  it("claims pre-agent-start ownership, closes text/thinking and progress", () => {
    let state = applySseEvent(createChatState(), { type: "text_delta", text: "a", requestId: "r1" });
    state = applySseEvent(state, { type: "thinking_delta", text: "b", requestId: "r1" });
    state = applySseEvent(state, start());
    expect(state.timeline.every(row => row.kind === "tool" || row.kind === "notification" || !row.streaming)).toBe(true);
    expect(state.modelOutput).toBeNull();
    state = applySseEvent(state, { type: "status", phase: "agent_start", requestId: "r1" });
    expect(state.compaction?.status).toBe("running");
  });
  it("end without start claims identity and survives same-request status", () => {
    let state = applySseEvent(createChatState(), end);
    state = applySseEvent(state, { type: "status", phase: "agent_start", requestId: "r1" });
    expect(state.activeRequestId).toBe("r1");
    expect(state.compaction?.status).toBe("succeeded");
  });
  it("new request clears old state; old starts/ends cannot steal active or completed new request", () => {
    const store = createChatStore(); store.applyEvent(start()); store.beginRequest("r2");
    expect(store.getState().compaction).toBeNull();
    store.applyEvent(start()); store.applyEvent(end);
    expect(store.getState().compaction).toBeNull();
    store.applyEvent({ type: "completed", requestId: "r2" }); store.applyEvent(start()); store.applyEvent(end);
    expect(store.getState().compaction).toBeNull();
  });
  it.each(["completed", "error", "aborted"] as const)("%s cannot leave running or infer success", type => {
    const state = applySseEvent(applySseEvent(createChatState(), start()), type === "error"
      ? { type, requestId: "r1", message: "failed" } : { type, requestId: "r1" });
    expect(state.compaction?.status).toBe(type === "completed" ? "unknown" : type === "error" ? "failed" : "aborted");
    const explicit = applySseEvent(applySseEvent(createChatState(), end), type === "error"
      ? { type, requestId: "r1", message: "failed" } : { type, requestId: "r1" });
    expect(explicit.compaction?.status).toBe("succeeded");
  });
  it("disconnect and restoration are uncertainty, not cancellation; live start/end confirm replay", () => {
    const store = createChatStore(); store.applyEvent(start()); store.markDisconnected();
    expect(store.getState().phase).toBe("streaming"); expect(store.getState().compaction?.status).toBe("unknown");
    store.applyEvent(start("r1", true)); expect(store.getState().compaction?.status).toBe("unknown");
    store.applyEvent(start()); expect(store.getState().compaction?.status).toBe("running");
    store.applyEvent({ ...end, replay: true }); expect(store.getState().compaction?.status).toBe("succeeded");
    store.clearModelOutput(); expect(store.getState().compaction?.status).toBe("succeeded");
  });
  it("clearing model output for cancellation preserves running until the actual terminal", () => {
    const store = createChatStore(); store.applyEvent(start()); store.clearModelOutput();
    expect(store.getState().modelOutput).toBeNull();
    expect(store.getState().compaction?.status).toBe("running");
    store.applyEvent({ type: "aborted", requestId: "r1" });
    expect(store.getState().compaction?.status).toBe("aborted");
  });
  it.each(["aborted", "error"] as const)("disconnected/restored unknown remains unknown on %s", type => {
    for (const restored of [false, true]) {
      const store = createChatStore();
      if (restored) store.restoreCompaction({ status: "running", reason: "threshold", requestId: "r1" });
      else { store.applyEvent(start()); store.markDisconnected(); }
      store.applyEvent(type === "error" ? { type, message: "failed", requestId: "r1" } : { type, requestId: "r1" });
      expect(store.getState().compaction?.status).toBe("unknown");
    }
  });
  it("finished compaction metadata does not claim task ownership; another queued request can abort", () => {
    const store = createChatStore();
    store.restoreCompaction({ status: "succeeded", reason: "threshold", requestId: "r1" });
    expect(store.getState().activeRequestId).toBeFalsy();
    store.applyEvent({ type: "queued", position: 1, requestId: "r2" });
    expect(store.getState().compaction).toBeNull();
    store.applyEvent({ type: "aborted", requestId: "r2" });
    expect(store.getState().phase).toBe("aborted");
  });
  it.each(["status", "text_delta", "completed"] as const)("restored succeeded survives same-request %s and terminal", type => {
    const store = createChatStore();
    store.restoreCompaction({ status: "succeeded", reason: "threshold", requestId: "r1" });
    store.applyEvent(type === "status" ? { type, phase: "agent_start", requestId: "r1" }
      : type === "text_delta" ? { type, text: "continued", requestId: "r1" } : { type, requestId: "r1" });
    expect(store.getState().compaction?.status).toBe("succeeded");
    store.applyEvent({ type: "completed", requestId: "r1" });
    expect(store.getState().compaction?.status).toBe("succeeded");
  });
  it("initial export cursor skips start but metadata restores unknown and next end restores outcome", () => {
    const bus = new SessionEventBus(); bus.push(start());
    const cursor = bus.lastEventId;
    const store = createChatStore();
    store.restoreCompaction({ status: "running", reason: "threshold", requestId: "r1" });
    store.applyEvent({ type: "status", phase: "agent_start", requestId: "r1" });
    expect(store.getState().compaction?.status).toBe("unknown");
    bus.push(end); bus.subscribe(item => store.applyEvent(item.event), cursor);
    expect(store.getState().compaction?.status).toBe("succeeded");
    const replayed: SseEvent[] = []; bus.subscribe(item => replayed.push(item.event), 0);
    expect(replayed).toEqual([{ ...start(), replay: true }, { ...end, replay: true }]);
  });
});
