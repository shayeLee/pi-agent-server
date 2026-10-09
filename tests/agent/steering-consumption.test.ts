import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { steeringSdkFixture } from "./steering-sdk-fixture.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { applySseEvent, createChatState } from "../../src/client/chat-state.js";
import type { SseEvent } from "../../src/shared/events.js";

it("real SDK exact queued object consumption acknowledges once while primary tool run stays active", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-steering-sdk-"));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline fixture forbids network"));
  const f = await steeringSdkFixture(root);
  const events: SseEvent[] = [];
  const runtime = new SessionRuntime({ sessionId: "isolated", ownerKey: "owner", adapter: f.adapter,
    concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 1, queueTimeoutMs: 1000 }),
    now: Date.now, onEvent: e => events.push(e) });
  const consumed = () => events.filter(e => e.type === "steering_consumed");
  try {
    await runtime.submitMessage({ userId: "owner", requestId: "primary", prompt: "same" });
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    const first = { controlId: "one", acknowledgementId: "owner-token", requestId: "primary", images: [{ mediaType: "image/png", base64: "aGVsbG8=" }] };
    expect(await runtime.steer("same", first, "owner")).toEqual({ kind: "ok" });
    expect(await runtime.steer("same", first, "owner")).toEqual({ kind: "ok" });
    expect(await runtime.steer("same", first, "other-actor")).toEqual({ kind: "conflict" });
    expect(await runtime.steer("different", first, "owner")).toEqual({ kind: "conflict" });
    expect(consumed()).toHaveLength(0); // HTTP admission is not consumption, even equal primary user text.
    f.release();
    await vi.waitFor(() => expect(consumed()).toHaveLength(1));
    await vi.waitFor(() => expect(f.waits()).toBe(2));
    expect(consumed()[0]).toEqual({ type: "steering_consumed", controlId: "one", acknowledgementId: "owner-token", requestId: "primary" });
    expect(runtime.state).toBe("streaming");
    expect(events.some(e => e.type === "completed")).toBe(false);
    const ack = consumed()[0]!;
    const state = { ...createChatState(), phase: "streaming" as const, activeRequestId: "primary" };
    expect(applySseEvent(state, ack)).toBe(state);
    expect(applySseEvent(applySseEvent(state, ack), ack)).toBe(state);
    const messages = f.session.messages.filter(m => m.role === "user");
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "same" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }]);
    const metadata = f.session.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === "pi-agent-server.steering-consumed");
    expect(metadata).toHaveLength(1);
    expect((metadata[0] as any).data).toEqual({ version: 1, controlId: "one", acknowledgementId: "owner-token", requestId: "primary" });
    // Equal text with distinct identities queues independently; cancellation cannot invent consumption.
    await Promise.all([runtime.steer("same", { controlId: "two", acknowledgementId: "token2", requestId: "primary" }),
      runtime.steer("same", { controlId: "three", acknowledgementId: "token3", requestId: "primary" })]);
    f.release();
    await vi.waitFor(() => expect(consumed()).toHaveLength(2));
    await vi.waitFor(() => expect(f.waits()).toBe(3));
    expect((consumed()[1] as any).controlId).toBe("two");
    await runtime.abort();
    expect(consumed()).toHaveLength(2);
    expect(await runtime.steer("same", { controlId: "late", acknowledgementId: "late", requestId: "primary" })).toEqual({ kind: "conflict" });
  } finally { runtime.dispose(); fetch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
