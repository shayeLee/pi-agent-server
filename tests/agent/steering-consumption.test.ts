import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { NativeSessionSource, nativeProjectDirectory } from "../../src/agent/native-session-source.js";
import { NativeSessionPolicy, canonicalCwdIdentity } from "../../src/core/native-session-policy.js";
import { openNativeSessionManager } from "../../src/agent/native-session-fd.js";
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
  const persistedAtConsumption: boolean[] = [];
  const runtime = new SessionRuntime({ sessionId: "isolated", ownerKey: "owner", adapter: f.adapter,
    concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 1, queueTimeoutMs: 1000 }),
    now: Date.now, onEvent: e => {
      if (e.type === "steering_consumed") {
        const entry = f.session.sessionManager.getBranch().find(entry => entry.id === e.message?.sourceId);
        persistedAtConsumption.push(entry?.type === "message" && f.session.messages.includes(entry.message));
      }
      events.push(e);
    } });
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
    expect(consumed()[0]).toMatchObject({ type: "steering_consumed", controlId: "one", acknowledgementId: "owner-token", requestId: "primary" });
    expect(persistedAtConsumption).toEqual([true]); // Not just eventual persistence after the callback.
    expect(runtime.state).toBe("streaming");
    expect(events.some(e => e.type === "completed")).toBe(false);
    const ack = consumed()[0]!;
    const state = { ...createChatState(), phase: "streaming" as const, activeRequestId: "primary" };
    const visible = applySseEvent(state, ack);
    expect(visible.timeline).toHaveLength(1);
    expect(visible.phase).toBe("streaming");
    expect(applySseEvent(visible, ack)).toBe(visible);
    const firstAck = ack as Extract<SseEvent, { type: "steering_consumed" }>;
    const entry = f.session.sessionManager.getBranch().find(e => e.id === firstAck.message?.sourceId);
    expect(entry?.type).toBe("message");
    expect(firstAck.message).toEqual({ sourceId: entry!.id, text: "same" }); // Invalid image fails closed.
    const nextDelta = events.findIndex((e, i) => i > events.indexOf(ack) && e.type === "text_delta");
    expect(nextDelta).toBeGreaterThan(events.indexOf(ack));
    expect(events.filter(e => e.type === "text_delta")).toHaveLength(2);
    const messages = f.session.messages.filter(m => m.role === "user");
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "same" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }]);
    const metadata = f.session.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === "pi-agent-server.steering-consumed");
    expect(metadata).toHaveLength(1);
    expect((metadata[0] as any).data).toEqual({ version: 1, controlId: "one", acknowledgementId: "owner-token", requestId: "primary", sourceId: entry!.id });
    // Equal text with distinct identities queues independently; cancellation cannot invent consumption.
    await Promise.all([runtime.steer("same", { controlId: "two", acknowledgementId: "token2", requestId: "primary" }),
      runtime.steer("same", { controlId: "three", acknowledgementId: "token3", requestId: "primary" })]);
    f.release();
    await vi.waitFor(() => expect(consumed()).toHaveLength(2));
    await vi.waitFor(() => expect(f.waits()).toBe(3));
    expect(persistedAtConsumption).toEqual([true, true]);
    expect((consumed()[1] as any).controlId).toBe("two");
    const second = applySseEvent(visible, consumed()[1]!);
    expect(second.timeline).toHaveLength(2);
    expect(second.timeline.map(e => e.id)[0]).not.toBe(second.timeline.map(e => e.id)[1]);
    const exported = await f.adapter.exportSession() as import("../../src/agent/session-export.js").ExportSnapshot;
    expect(exported.messages.filter(m => m.role === "user")).toHaveLength(3);
    for (const e of consumed() as Extract<SseEvent, { type: "steering_consumed" }>[]) {
      expect(exported.messages.find(m => m.sourceId === e.message!.sourceId)?.text).toBe("same");
    }
    await runtime.abort();
    expect(consumed()).toHaveLength(2);
    expect(await runtime.steer("same", { controlId: "late", acknowledgementId: "late", requestId: "primary" })).toEqual({ kind: "conflict" });
  } finally { runtime.dispose(); fetch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});


it.each(["invalid-fd", "subscriber"])("contains deferred steering %s failure in its owning native request", async mode => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-steering-failure-")));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline fixture forbids network"));
  const dir = join(root, "sources", nativeProjectDirectory(root)); mkdirSync(dir, { recursive: true });
  const file = join(dir, "fixture.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "native-fixture", cwd: root }) + "\n");
  const source = new NativeSessionSource(join(root, "sources"), new NativeSessionPolicy([]));
  const binding = (await source.scan(canonicalCwdIdentity(root))).sources[0]!.binding;
  const { manager, descriptor } = openNativeSessionManager(source, binding);
  const append = manager.appendCustomEntry.bind(manager);
  const attempted = vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
    if (type === "pi-agent-server.steering-consumed" && mode === "invalid-fd") descriptor.close();
    return append(type, data); // Actual SDK append -> pinned FD failure, after user persistence.
  });
  const f = await steeringSdkFixture(root, undefined, manager);
  const poisoned = vi.fn(() => {
    // Match the native factory's descriptor poison teardown.
    void f.session.abort().catch(() => {});
    f.session.dispose();
    source.revoke(binding);
  });
  descriptor.onPoison = poisoned;
  const events: SseEvent[] = [];
  if (mode === "subscriber") f.adapter.subscribeSteeringConsumed(() => { throw new Error("downstream failed"); });
  // Reporting subscribers may also throw; never recurse or crash the process.
  f.adapter.subscribeRequestError(() => { throw new Error("error reporter failed"); });
  const runtime = new SessionRuntime({ sessionId: "isolated", ownerKey: "owner", adapter: f.adapter,
    concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 1, queueTimeoutMs: 1000 }),
    now: Date.now, onEvent: e => events.push(e) });
  try {
    await runtime.submitMessage({ userId: "owner", requestId: "primary", prompt: "primary" });
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    await runtime.steer("already visible", { controlId: "one", acknowledgementId: "token", requestId: "primary" });
    f.release();
    await vi.waitFor(() => expect(events.filter(e => e.type === "error")).toHaveLength(1));
    expect(events.filter(e => ["completed", "aborted", "steering_consumed"].includes(e.type))).toHaveLength(0);
    expect(events.find(e => e.type === "error")).toMatchObject({ requestId: "primary" });
    expect(f.calls()).toBe(1); // Stream gate blocks the continuation model request.
    expect(readFileSync(file, "utf8")).toContain("already visible");
    const exported = await f.adapter.exportSession() as import("../../src/agent/session-export.js").ExportSnapshot;
    expect(exported.messages.some(m => m.text === "already visible")).toBe(true);
    if (mode === "invalid-fd") {
      expect(readFileSync(file, "utf8")).not.toContain("pi-agent-server.steering-consumed");
      expect(poisoned).toHaveBeenCalledTimes(1);
    }
    expect(attempted.mock.calls.filter(([type]) => type === "pi-agent-server.steering-consumed")).toHaveLength(1);
    expect(await runtime.submitMessage({ userId: "owner", requestId: "next", prompt: "never retry" })).toMatchObject({ kind: "conflict", reason: "poisoned" });
    expect(f.calls()).toBe(1);
  } finally { runtime.dispose(); descriptor.close(); fetch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
