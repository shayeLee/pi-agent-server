import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { steeringSdkFixture } from "./steering-sdk-fixture.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import type { SseEvent } from "../../src/shared/events.js";

it("promoted original transformed object consumes its exact draft once without replaying input extensions; public pending counts agree with resident queues and do not continue a settled run", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-promotion-sdk-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  let processed = 0, calls = 0;
  let hasPending!: () => boolean;
  const f = await steeringSdkFixture(root, session => {
    const original = session.agent.streamFunction;
    session.agent.streamFunction = (...args) => {
      if (++calls === 1) return original(...args);
      const message: any = { role: "assistant", content: [{ type: "text", text: "done" }],
        api: args[0].api, provider: args[0].provider, model: args[0].id, stopReason: "stop", timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
    };
  }, undefined, [pi => { pi.on("input", async (event, ctx) => {
    hasPending = () => ctx.hasPendingMessages();
    if (event.text === "same") { processed++; return { action: "transform", text: "transformed", images: event.images }; }
    return { action: "continue" };
  }); }]);
  const events: SseEvent[] = [];
  const runtime = new SessionRuntime({ sessionId: "session", ownerKey: "owner", adapter: f.adapter, now: Date.now,
    concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 1, queueTimeoutMs: 1000 }), onEvent: event => events.push(event) });
  try {
    await runtime.submitMessage({ userId: "owner", requestId: "run", prompt: "primary" });
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    const identity = { controlId: "promoted", acknowledgementId: "ack", requestId: "run" };
    await runtime.followUp("same", identity);
    const object = f.session.agent.peekQueuedMessages()[0];
    expect(runtime.getControlQueue().items[0]?.text).toBe("transformed");
    expect(hasPending()).toBe(true);
    expect(f.session.pendingMessageCount).toBe(1);
    expect(f.session.getFollowUpMessages()).toEqual(["transformed"]);
    expect(runtime.mutateControlQueue(identity, "promote").kind).toBe("ok");
    expect(f.session.getSteeringMessages()).toEqual(["transformed"]);
    expect(f.session.getFollowUpMessages()).toEqual([]);
    expect(f.session.agent.peekQueuedMessages()[0]).toBe(object);
    await runtime.followUp("delete-only", { ...identity, controlId: "deleted", acknowledgementId: "other" });
    runtime.mutateControlQueue({ ...identity, controlId: "deleted", acknowledgementId: "other" }, "delete");
    f.release();
    await vi.waitFor(() => expect(runtime.state).toBe("idle"));
    expect(processed).toBe(1); expect(calls).toBe(2);
    expect(f.session.agent.hasQueuedMessages()).toBe(false);
    expect(f.session.pendingMessageCount).toBe(0);
    expect(hasPending()).toBe(false);
    expect(f.session.getSteeringMessages()).toEqual([]);
    expect(f.session.getFollowUpMessages()).toEqual([]);
    const acknowledgements = events.filter(e => e.type === "steering_consumed");
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({ type: "steering_consumed", ...identity, message: { text: "transformed", sourceId: expect.any(String) } });
    const queued = events.findIndex(e => e.type === "control_queue" && e.items.some(item => item.id === "promoted"));
    const empty = events.findIndex((e, index) => index > queued && e.type === "control_queue" && e.requestId === "run" && e.items.length === 0);
    expect(empty).toBeGreaterThan(0); expect(events.indexOf(acknowledgements[0]!)).toBeGreaterThan(empty);
    expect(events.filter(e => e.type === "control_queue").at(-1)).toMatchObject({ requestId: null, items: [] });
  } finally { await runtime.abort(); runtime.dispose(); network.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
