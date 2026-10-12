import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { steeringSdkFixture } from "./steering-sdk-fixture.js";

const identity = (id: string) => ({ controlId: id, requestId: "run", acknowledgementId: `ack-${id}` });
it.each(["peekQueuedMessages", "clearSteeringQueue"] as const)("unrecoverable public core %s failure aborts and permanently poisons the adapter instead of executing an unknown marker queue", async method => {
  const root = mkdtempSync(join(tmpdir(), "pi-fatal-public-queue-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const f = await steeringSdkFixture(root);
  const run = f.adapter.prompt("primary");
  const original = f.session.agent[method];
  try {
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    await f.adapter.followUp("retain-if-possible", identity("a"));
    f.session.agent[method] = () => { throw new Error("persistent core failure"); };
    expect(() => f.adapter.getControlQueueItems()).toThrow(AggregateError);
    // Broken peek can still be cleared; permanently broken clear leaves a residual marker.
    // Abort + permanent poison must isolate it even if SDK attempts a final drain.
    expect(f.session.agent.hasQueuedMessages()).toBe(method === "clearSteeringQueue");
    await run;
    expect(f.calls()).toBe(1);
    const userMessages = () => f.session.messages.filter(message => message.role === "user");
    expect(userMessages()).toHaveLength(1);
    expect(userMessages()[0]?.content).toEqual([{ type: "text", text: "primary" }]);
    const persistedUsers = () => f.session.sessionManager.getBranch().filter(entry =>
      entry.type === "message" && entry.message.role === "user");
    expect(persistedUsers()).toHaveLength(1);
    const poisonMessage = method === "clearSteeringQueue" ? "Resident queue clear failed" : "recovery unavailable";
    await expect(f.adapter.prompt("must not resume damaged queues")).rejects.toThrow(poisonMessage);
    f.session.agent[method] = original as any;
    await expect(f.adapter.prompt("even repaired core must stay poisoned")).rejects.toThrow(poisonMessage);
    expect(f.calls()).toBe(1);
    expect(userMessages()).toHaveLength(1);
    expect(persistedUsers()).toHaveLength(1);
  } finally {
    f.session.agent[method] = original as any;
    await f.adapter.abort(); await run; f.adapter.dispose();
    network.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});
it("real extension pending getter, public lists and subscriptions follow resident delete/promote, not SDK display mirrors", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-public-queue-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  let hasPending!: () => boolean;
  let ownBefore: PropertyDescriptor | undefined;
  const f = await steeringSdkFixture(root, session => { ownBefore = Object.getOwnPropertyDescriptor(session, "pendingMessageCount"); }, undefined,
    [pi => { pi.on("input", (_event, ctx) => { hasPending = () => ctx.hasPendingMessages(); return { action: "continue" }; }); }]);
  const updates: any[] = [];
  const unsubscribe = f.session.subscribe(event => { if (event.type === "queue_update") updates.push(event); });
  const run = f.adapter.prompt("primary");
  try {
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    expect(hasPending()).toBe(false);
    await f.adapter.followUp("only", identity("only"));
    expect(hasPending()).toBe(true);
    expect(f.adapter.mutateControlQueue(identity("only"), "delete")).toBe(true);
    expect(hasPending()).toBe(false); expect(f.session.pendingMessageCount).toBe(0);
    expect(f.session.getFollowUpMessages()).toEqual([]);
    expect(updates.at(-1)).toMatchObject({ steering: [], followUp: [] });
    await f.session.followUp("untracked");
    await f.adapter.followUp("promoted", identity("promoted"));
    f.session.agent.followUpMode = "all";
    const originals = f.session.agent.peekQueuedMessages();
    expect(f.adapter.mutateControlQueue(identity("promoted"), "promote")).toBe(true);
    expect(f.session.getSteeringMessages()).toEqual(["promoted"]);
    expect(f.session.getFollowUpMessages()).toEqual(["untracked"]);
    expect(f.session.pendingMessageCount).toBe(2); expect(hasPending()).toBe(true);
    expect(f.session.agent.peekQueuedMessages()[0]).toBe(originals[1]);
    expect(updates.at(-1)).toMatchObject({ steering: ["promoted"], followUp: ["untracked"] });
    expect(f.adapter.mutateControlQueue(identity("promoted"), "delete")).toBe(true);
    expect(f.session.getFollowUpMessages()).toEqual(["untracked"]); expect(hasPending()).toBe(true);
    f.session.clearQueue();
    expect(hasPending()).toBe(false);
    expect(updates.at(-1)).toMatchObject({ steering: [], followUp: [] });
  } finally {
    unsubscribe(); await f.adapter.abort(); await run; f.adapter.dispose();
    expect(Object.getOwnPropertyDescriptor(f.session, "pendingMessageCount")).toEqual(ownBefore);
    expect(Object.hasOwn(f.session, "getSteeringMessages")).toBe(false);
    expect(Object.hasOwn(f.session, "subscribe")).toBe(false);
    network.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});
it.each(["delete", "dispose"] as const)("processing real input extensions do not create phantom queues, including late %s", async operation => {
  const root = mkdtempSync(join(tmpdir(), "pi-late-public-queue-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  let release!: () => void, entered!: () => void, hasPending!: () => boolean;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const f = await steeringSdkFixture(root, undefined, undefined, [pi => { pi.on("input", async (event, ctx) => {
    hasPending = () => ctx.hasPendingMessages();
    if (event.text === "late") { entered(); await gate; }
    return { action: "continue" };
  }); }]);
  const updates: any[] = []; f.session.subscribe(event => { if (event.type === "queue_update") updates.push(event); });
  const run = f.adapter.prompt("primary");
  try {
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    const submission = f.adapter.steer("late", identity("late"));
    await ready; expect(hasPending()).toBe(false); expect(f.session.pendingMessageCount).toBe(0);
    if (operation === "delete") expect(f.adapter.mutateControlQueue(identity("late"), "delete")).toBe(true);
    else { await f.adapter.abort(); await run; f.adapter.dispose(); }
    release(); await submission;
    expect(f.session.agent.peekQueuedMessages()).toEqual([]);
    expect(f.session.pendingMessageCount).toBe(0);
    if (operation === "delete") expect(hasPending()).toBe(false);
    expect(updates.every(event => event.steering.length === 0 && event.followUp.length === 0)).toBe(true);
    if (operation === "dispose") expect(Object.hasOwn(f.session, "pendingMessageCount")).toBe(false);
  } finally {
    release(); if (operation !== "dispose") { await f.adapter.abort(); await run; f.adapter.dispose(); }
    network.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});

it("serializes real SDK public queue updates when the first listener synchronously clears", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reentrant-public-queue-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const f = await steeringSdkFixture(root);
  const seenA: unknown[] = [], seenB: unknown[] = [];
  const offA = f.session.subscribe(event => {
    if (event.type !== "queue_update") return;
    seenA.push(event);
    // Repeated clear on empty must not cause a queue_update loop either.
    f.session.clearQueue();
  });
  const offB = f.session.subscribe(event => { if (event.type === "queue_update") seenB.push(event); });
  const run = f.adapter.prompt("primary");
  try {
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    seenA.length = 0; seenB.length = 0;
    await f.adapter.followUp("clear synchronously", identity("clear"));
    expect(seenA).toEqual(seenB);
    expect(seenB).toEqual([
      { type: "queue_update", steering: [], followUp: ["clear synchronously"] },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(f.session.pendingMessageCount).toBe(0);
    f.session.clearQueue();
    expect(seenB).toHaveLength(2);
  } finally {
    offA(); offB(); await f.adapter.abort(); await run; f.adapter.dispose();
    network.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});
