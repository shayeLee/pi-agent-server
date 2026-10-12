import { expect, it } from "vitest";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";

function registry(createAdapter = async () => new MockAgentAdapter()) {
  return new RuntimeRegistry({ createAdapter, concurrency: new ConcurrencyController({ globalLimit: 1,
    perUserLimit: 1, perUserQueueLimit: 1, globalQueueLimit: 1, queueTimeoutMs: 1000 }) });
}
it("session-scoped revision clocks survive runtime/registry incarnations; absent watermark is stable and live GET uses runtime authority", async () => {
  const first = registry(), second = registry();
  try {
    const empty = await first.getControlQueue("revision-incarnation");
    expect(await first.getControlQueue("revision-incarnation")).toEqual(empty);
    expect(first.get("revision-incarnation")).toBeUndefined();
    const entry = await first.getOrCreate("revision-incarnation", "owner");
    const live = entry.runtime.getControlQueue();
    expect(live.revision).toBeGreaterThan(empty.revision);
    expect(await first.getControlQueue("revision-incarnation")).toEqual(live);
    expect((await first.getOrCreate("revision-incarnation", "owner")).runtime).toBe(entry.runtime);
    await first.delete("revision-incarnation");
    const deleted = await first.getControlQueue("revision-incarnation");
    expect(deleted.revision).toBeGreaterThan(live.revision);
    expect(await first.getControlQueue("revision-incarnation")).toEqual(deleted);
    // A separate registry models a replacement lifecycle without poking private maps.
    const replacement = await second.getOrCreate("revision-incarnation", "owner");
    expect(replacement.runtime.getControlQueue().revision).toBeGreaterThan(deleted.revision);
    const unrelated = await second.getControlQueue("revision-unrelated");
    expect(unrelated.revision).toBe(1);
  } finally { await first.abortAll(); first.dispose(); await second.abortAll(); second.dispose(); }
});
it("GET during pending creation cannot allocate an empty watermark that outranks the new live snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const r = registry(async () => { await gate; return new MockAgentAdapter(); });
  try {
    const before = await r.getControlQueue("revision-pending");
    const creating = r.getOrCreate("revision-pending", "owner");
    const reading = r.getControlQueue("revision-pending");
    release(); const entry = await creating;
    const during = await reading;
    expect(during).toEqual(entry.runtime.getControlQueue());
    expect(during.revision).toBeGreaterThan(before.revision);
  } finally { release(); await r.abortAll(); r.dispose(); }
});
