import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { steeringSdkFixture } from "./steering-sdk-fixture.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import type { SseEvent } from "../../src/shared/events.js";
import { PNG_2X2_BASE64 } from "../helpers/image-fixtures.js";

const identity = (controlId: string) => ({ controlId, requestId: "run", acknowledgementId: `ack-${controlId}` });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(configure?: Parameters<typeof steeringSdkFixture>[1], extensions: Parameters<typeof steeringSdkFixture>[3] = []) {
  const root = mkdtempSync(join(tmpdir(), "pi-control-queue-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline SDK fixture forbids network"));
  const sdk = await steeringSdkFixture(root, configure, undefined, extensions);
  const events: SseEvent[] = [];
  const runtime = new SessionRuntime({ sessionId: "session", ownerKey: "owner", adapter: sdk.adapter,
    concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 1, queueTimeoutMs: 1000 }),
    now: Date.now, onEvent: event => events.push(event) });
  return { ...sdk, runtime, events, async start() {
    await runtime.submitMessage({ userId: "owner", requestId: "run", prompt: "primary" });
    await vi.waitFor(() => expect(sdk.waits()).toBe(1));
  }, async cleanup() { await runtime.abort(); runtime.dispose(); network.mockRestore(); rmSync(root, { recursive: true, force: true }); } };
}

it("real resident objects: promotion/deletion preserve images/custom messages/order and identity, with actor/ack/run fencing and tombstones", async () => {
  const f = await fixture();
  try {
    await f.start();
    const input = { ...identity("a"), images: [{ mediaType: "image/png", base64: PNG_2X2_BASE64 }] };
    await f.runtime.followUp("same", input);
    await f.runtime.followUp("same", identity("b"));
    const custom: any = { role: "custom", customType: "fixture", content: "retain", display: false, timestamp: 0 };
    f.session.agent.followUp(custom);
    f.session.agent.followUpMode = "all";
    const original = f.session.agent.peekQueuedMessages();
    const initial = f.runtime.getControlQueue();
    expect(initial.items.map(i => [i.id, i.kind, i.hasImages])).toEqual([["a", "followUp", true], ["b", "followUp", false]]);
    expect(JSON.stringify(initial)).not.toContain(PNG_2X2_BASE64);
    expect(f.runtime.mutateControlQueue(identity("a"), "promote", "other")).toEqual({ kind: "conflict" });
    expect(f.runtime.mutateControlQueue({ ...identity("a"), acknowledgementId: "wrong" }, "delete")).toEqual({ kind: "conflict" });
    expect(f.runtime.mutateControlQueue({ ...identity("a"), requestId: "old" }, "delete")).toEqual({ kind: "conflict" });
    expect(f.runtime.mutateControlQueue(identity("a"), "promote").kind).toBe("ok");
    expect(f.session.agent.peekQueuedMessages()[0]).toBe(original[0]);
    expect(f.runtime.mutateControlQueue(identity("a"), "promote").kind).toBe("ok");
    expect(f.runtime.mutateControlQueue(identity("b"), "delete").kind).toBe("ok");
    expect(f.runtime.mutateControlQueue(identity("b"), "delete").kind).toBe("ok");
    await f.runtime.followUp("same", identity("b")); // Replay never revives deletion.
    expect(f.runtime.getControlQueue().items.map(i => i.id)).toEqual(["a"]);
    f.session.agent.steeringMode = "all";
    expect(f.session.agent.peekQueuedMessages()[0]).toBe(original[0]);
    f.session.agent.clearSteeringQueue();
    expect(f.session.agent.peekQueuedMessages()).toEqual([custom]);
    expect(f.runtime.mutateControlQueue(identity("a"), "promote")).toEqual({ kind: "conflict" });
    expect(f.runtime.getControlQueue().items).toEqual([]);
    expect(f.events.filter(e => e.type === "steering_consumed")).toEqual([]);
    expect(f.runtime.getControlQueue().revision).toBeGreaterThan(initial.revision);
    await f.runtime.abort();
    expect(f.runtime.getControlQueue()).toMatchObject({ requestId: null, items: [] });
    expect(f.events.filter(e => e.type === "control_queue").at(-1)).toMatchObject({ requestId: null, items: [] });
  } finally { await f.cleanup(); }
});

it.each(["steer", "followUp"] as const)("all %s drain is removed as one batch at prepare entry before a long await or persistence acknowledgement", async kind => {
  const entered = deferred(), release = deferred();
  let prepared = false, preparations = 0;
  const f = await fixture(session => {
    session.agent.steeringMode = "all"; session.agent.followUpMode = "all";
    if (kind === "followUp") {
      const stream = session.agent.streamFunction;
      let calls = 0;
      session.agent.streamFunction = (...args) => {
        if (++calls === 1) return stream(...args);
        const message: any = { role: "assistant", content: [{ type: "text", text: "offline done" }],
          api: args[0].api, provider: args[0].provider, model: args[0].id, stopReason: "stop", timestamp: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const result = createAssistantMessageEventStream();
        result.push({ type: "done", reason: "stop", message }); result.end(message); return result;
      };
    }
    const original = session.agent.prepareNextTurnWithContext!;
    session.agent.prepareNextTurnWithContext = async (...args) => {
      preparations++;
      if (!prepared && (kind === "steer" || preparations === 2)) { prepared = true; entered.resolve(); await release.promise; }
      return original(...args);
    };
  });
  try {
    await f.start();
    await f.runtime[kind]("equal", identity("a")); await f.runtime[kind]("equal", identity("b"));
    const before = f.runtime.getControlQueue();
    expect(before.items).toHaveLength(2);
    f.release(); await entered.promise;
    expect(f.events.filter(e => e.type === "control_queue").at(-1)).toMatchObject({ items: [], requestId: "run", revision: before.revision + 1 });
    expect(f.events.filter(e => e.type === "steering_consumed")).toHaveLength(0);
    expect(f.runtime.mutateControlQueue(identity("a"), "delete")).toEqual({ kind: "conflict" });
    expect(f.runtime.mutateControlQueue(identity("b"), "promote")).toEqual({ kind: "conflict" });
    expect(f.session.agent.peekQueuedMessages()).toEqual([]);
    release.resolve();
    await vi.waitFor(() => expect(kind === "steer" ? f.waits() : f.runtime.state).toBe(kind === "steer" ? 2 : "idle"));
    expect(f.events.filter(e => e.type === "steering_consumed")).toHaveLength(2);
  } finally { release.resolve(); await f.cleanup(); }
});

it.each([false, true])("secondary all drain: immediate public-boundary SSE or authoritative API while observer delayed=%s", async delayed => {
  const preparing = deferred(), releasePrepare = deferred(), drained = deferred(), releaseEvent = deferred();
  let prepared = false, turns = 0;
  const f = await fixture(session => {
    session.agent.steeringMode = "all";
    const original = session.agent.prepareNextTurnWithContext!;
    session.agent.prepareNextTurnWithContext = async (...args) => {
      if (!prepared) { prepared = true; preparing.resolve(); await releasePrepare.promise; }
      return original(...args);
    };
    session.agent.subscribe(async event => {
      if (event.type === "turn_start" && ++turns === 2) { drained.resolve(); if (delayed) await releaseEvent.promise; }
    });
  });
  try {
    await f.start(); f.release(); await preparing.promise;
    await f.runtime.steer("same", identity("a")); await f.runtime.steer("same", identity("b"));
    expect(f.runtime.getControlQueue().items).toHaveLength(2);
    releasePrepare.resolve(); await drained.promise;
    if (!delayed) {
      await vi.waitFor(() => expect(f.events.filter(e => e.type === "control_queue").at(-1)).toMatchObject({ requestId: "run", items: [] }));
    }
    expect(f.session.agent.peekQueuedMessages()).toEqual([]);
    expect(f.runtime.mutateControlQueue(identity("a"), "delete")).toEqual({ kind: "conflict" });
    expect(f.runtime.getControlQueue().items).toEqual([]);
    expect(f.runtime.mutateControlQueue(identity("b"), "promote")).toEqual({ kind: "conflict" });
    expect(f.session.agent.peekQueuedMessages()).toEqual([]); // No resurrection from a stale mirror.
    if (delayed) expect(f.events.filter(e => e.type === "steering_consumed")).toHaveLength(0);
    releaseEvent.resolve(); await vi.waitFor(() => expect(f.waits()).toBe(2));
  } finally { releasePrepare.resolve(); releaseEvent.resolve(); await f.cleanup(); }
});

it("first-turn all drain reconciles at public message_start, independently of consumption persistence", async () => {
  let enqueue!: () => Promise<void>;
  const f = await fixture(session => {
    session.agent.steeringMode = "all";
    session.agent.subscribe(async event => { if (event.type === "agent_start") await enqueue(); });
  });
  enqueue = async () => { await f.runtime.steer("same", identity("a")); await f.runtime.steer("same", identity("b")); };
  try {
    await f.start();
    expect(f.runtime.getControlQueue().items).toEqual([]);
    const queued = f.events.findIndex(e => e.type === "control_queue" && e.items.length === 2);
    const removal = f.events.findIndex((e, index) => index > queued && e.type === "control_queue" && e.items.length === 0);
    const ack = f.events.findIndex(e => e.type === "steering_consumed");
    expect(removal).toBeGreaterThan(0); expect(ack).toBeGreaterThan(removal);
    expect(f.events.filter(e => e.type === "steering_consumed")).toHaveLength(2);
  } finally { await f.cleanup(); }
});

it.each(["delete", "abort", "new-run"] as const)("pending real SDK input extension late enqueue is fenced after %s", async operation => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(undefined, [pi => {
    pi.on("input", async event => {
      if (event.text !== "late") return { action: "continue" };
      entered.resolve(); await gate.promise;
      return { action: "transform", text: "transformed late", images: event.images };
    });
  }]);
  try {
    await f.start();
    const submission = f.runtime.steer("late", identity("a")).catch(error => ({ kind: "failed", error }));
    await entered.promise;
    expect(f.runtime.getControlQueue().items).toEqual([]);
    if (operation === "delete") expect(f.runtime.mutateControlQueue(identity("a"), "delete").kind).toBe("ok");
    else {
      await f.runtime.abort();
      if (operation === "new-run") {
        await f.session.waitForIdle();
        await vi.waitFor(() => expect(f.runtime.state).toBe("idle"));
        expect(await f.runtime.submitMessage({ userId: "owner", requestId: "new-run", prompt: "next primary" })).toEqual({ kind: "run" });
        await vi.waitFor(() => expect(f.waits()).toBe(2));
      }
    }
    gate.resolve();
    expect(await submission).toEqual({ kind: operation === "delete" ? "ok" : "conflict" });
    expect(f.session.agent.peekQueuedMessages()).toEqual([]);
    expect(f.runtime.mutateControlQueue(identity("a"), "delete").kind).toBe(operation === "delete" ? "ok" : "conflict");
    expect(f.events.filter(e => e.type === "steering_consumed")).toEqual([]);
  } finally { gate.resolve(); await f.cleanup(); }
});
