import { expect, it } from "vitest";
import { applySseEvent, createChatState } from "../../src/client/chat-state.js";
import type { SseEvent } from "../../src/shared/events.js";

const consumed = (sourceId: string, requestId = "primary"): SseEvent => ({ type: "steering_consumed", controlId: sourceId,
  acknowledgementId: `actor:${sourceId}`, requestId, message: { sourceId, text: "same", images: [{ mediaType: "image/png", base64: "safe-projection" }] } });

it("consumed closes presentation, not task; replay/history dedup uses entry ID, never text", () => {
  let state = { ...createChatState(), phase: "streaming" as const, activeRequestId: "primary" };
  state = applySseEvent(state, { type: "text_delta", text: "before", requestId: "primary" }) as typeof state;
  state = applySseEvent(state, { type: "thinking_delta", text: "thinking", requestId: "primary" }) as typeof state;
  const after = applySseEvent(state, consumed("one"));
  expect(after.phase).toBe("streaming");
  expect(after.activeRequestId).toBe("primary");
  expect(after.timeline.filter(row => row.kind !== "tool" && row.kind !== "notification").every(row => !row.streaming)).toBe(true);
  expect(after.timeline.at(-1)).toMatchObject({ role: "user", text: "same", images: [{ mediaType: "image/png", base64: "safe-projection" }] });
  expect(applySseEvent(after, consumed("one"))).toBe(after);
  const second = applySseEvent(after, consumed("two"));
  expect(second.timeline.filter(row => row.kind === "message" && row.role === "user")).toHaveLength(2);
  const next = applySseEvent(second, { type: "text_delta", text: "after", requestId: "primary" });
  expect(next.timeline.at(-1)).toMatchObject({ role: "assistant", text: "after" });
  const restored = { ...createChatState(), timeline: second.timeline.map(row => ({ ...row })) };
  expect(applySseEvent(restored, consumed("one"))).toBe(restored);
});

it("old server, wrong primary request and unconsumed cancellation cannot invent a user", () => {
  const state = { ...createChatState(), phase: "streaming" as const, activeRequestId: "primary" };
  expect(applySseEvent(state, { type: "steering_consumed", controlId: "old", acknowledgementId: "old", requestId: "primary" })).toBe(state);
  expect(applySseEvent(state, consumed("wrong", "other"))).toBe(state);
  expect(applySseEvent(state, { type: "aborted", requestId: "primary" }).timeline).toEqual([]);
});
