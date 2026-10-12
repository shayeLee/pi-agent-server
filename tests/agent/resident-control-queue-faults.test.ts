import { expect, it } from "vitest";
import { ResidentControlQueue, type ResidentQueueAgent } from "../../src/agent/resident-control-queue.js";

const identity = { controlId: "a", requestId: "run", acknowledgementId: "ack" };
function fixture(fault: string) {
  const image = { role: "user", content: [{ type: "image", data: "original", mimeType: "image/png" }] };
  const custom = { role: "custom", content: "unchanged", custom: { original: true } };
  let steer: object[] = [image], followUp: object[] = [custom];
  const calls = new Map<string, number>();
  const check = (name: string) => {
    const n = (calls.get(name) ?? 0) + 1; calls.set(name, n);
    if (`${name}:${n}` === fault) throw new Error(fault);
  };
  let sm: ResidentQueueAgent["steeringMode"] = "one-at-a-time", fm: ResidentQueueAgent["followUpMode"] = "one-at-a-time";
  const agent: ResidentQueueAgent = {
    get steeringMode() { return sm; }, set steeringMode(mode) { check("sm"); sm = mode; },
    get followUpMode() { return fm; }, set followUpMode(mode) { check("fm"); fm = mode; },
    steer(message) { check("steer"); steer.push(message); },
    followUp(message) { check("followUp"); followUp.push(message); },
    peekQueuedMessages() { check("peek"); return [...(steer.length ? steer : followUp)]; },
    clearSteeringQueue() { check("clearSteer"); steer = []; },
    clearFollowUpQueue() { check("clearFollowUp"); followUp = []; },
  };
  const fatal: Error[] = [];
  const queue = new ResidentControlQueue(agent, m => agent.steer(m), m => agent.followUp(m), error => { fatal.push(error); });
  queue.track(image, identity);
  return { queue, agent, image, custom, fatal, queues: () => ({ steer, followUp }) };
}
it.each(["sm:1", "fm:1", "steer:1", "peek:1", "clearSteer:1", "peek:2", "clearFollowUp:1", "steer:2", "followUp:1", "sm:2", "fm:2"])("restores original references and both modes, propagating transient before-effect fault %s", fault => {
  const f = fixture(fault);
  expect(() => f.queue.snapshot()).toThrow();
  expect(f.queues().steer).toEqual([f.image]); expect(f.queues().steer[0]).toBe(f.image);
  expect(f.queues().followUp).toEqual([f.custom]); expect(f.queues().followUp[0]).toBe(f.custom);
  expect(f.agent.steeringMode).toBe("one-at-a-time"); expect(f.agent.followUpMode).toBe("one-at-a-time");
  expect(f.queue.snapshot()).toHaveLength(1);
});
it("marker validation failure removes the marker and preserves originals", () => {
  const f = fixture(""); const peek = f.agent.peekQueuedMessages;
  let first = true;
  f.agent.peekQueuedMessages = () => { const messages = peek(); if (first) { first = false; return messages.reverse(); } return messages; };
  expect(() => f.queue.snapshot()).toThrow("Unsupported resident queue semantics");
  expect(f.queues()).toEqual({ steer: [f.image], followUp: [f.custom] });
  expect(f.agent.steeringMode).toBe("one-at-a-time");
});
it("mutation rolls back after restoration failure without losing tracking", () => {
  const f = fixture("followUp:1");
  expect(() => f.queue.mutate(identity, "delete")).toThrow();
  expect(f.queues().steer[0]).toBe(f.image);
  expect(f.queue.snapshot()).toHaveLength(1);
});
it("persistent peek failure is surfaced and fails closed: no marker can execute; unavailable originals cannot be recovered via public API", () => {
  const f = fixture(""); f.agent.peekQueuedMessages = () => { throw new Error("unavailable"); };
  expect(() => f.queue.snapshot()).toThrow(AggregateError);
  expect(f.fatal).toHaveLength(1);
  expect(f.queues().steer).toEqual([]); // explicit limitation, not an atomic-rollback claim
  expect(f.queues().followUp[0]).toBe(f.custom);
  expect(f.agent.steeringMode).toBe("one-at-a-time"); expect(f.agent.followUpMode).toBe("one-at-a-time");
});
it("persistent restoration enqueue errors do not skip follow-up recovery or either mode reset", () => {
  const f = fixture(""); const enqueue = f.agent.steer; let calls = 0;
  f.agent.steer = message => { if (++calls > 1) throw new Error("enqueue unavailable"); enqueue(message); };
  expect(() => f.queue.snapshot()).toThrow(AggregateError);
  expect(f.fatal).toHaveLength(1);
  expect(f.queues()).toEqual({ steer: [], followUp: [f.custom] });
  // Persistent public enqueue failure prevents restoring steering, but must not skip other recovery.
  expect(f.agent.steeringMode).toBe("one-at-a-time"); expect(f.agent.followUpMode).toBe("one-at-a-time");
});
