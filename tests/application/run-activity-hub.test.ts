import { describe, expect, it } from "vitest";
import { RunActivityHub, activityMessage, fanOutObservability, type RawActivity } from "../../src/application/run-activity-hub.js";
import { ActivityService } from "../../src/application/activity-service.js";

const HOUR = 60 * 60 * 1000;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("RunActivityHub", () => {
  it("tracks a run from start to end and keeps how it ended", async () => {
    const time = clock();
    const hub = new RunActivityHub({ now: time.now });
    const seen: RawActivity[] = [];
    hub.subscribe(activity => seen.push(activity));

    hub.observe({ type: "turn_started", sessionId: "s1", requestId: "r1" });
    expect(hub.snapshot().running).toEqual([{ sessionId: "s1", startedAt: time.now() }]);

    time.advance(1500);
    hub.observe({ type: "turn", sessionId: "s1", requestId: "r1", outcome: "completed", durationMs: 1500, ttftMs: 10 });
    const snapshot = hub.snapshot();
    expect(snapshot.running).toEqual([]);
    expect(snapshot.recent).toEqual([{ id: 2, at: time.now(), sessionId: "s1", kind: "completed", durationMs: 1500 }]);
    expect(snapshot.lastId).toBe(2);
    expect(seen.map(activity => activity.kind)).toEqual(["started", "completed"]);
  });

  it("a failed run carries the first line of its error", async () => {
    const hub = new RunActivityHub();
    const seen: RawActivity[] = [];
    hub.subscribe(activity => seen.push(activity));
    hub.observe({ type: "turn_started", sessionId: "s1", requestId: "r1" });
    // The runtime reports the turn, then its error, in the same tick.
    hub.observe({ type: "turn", sessionId: "s1", requestId: "r1", outcome: "error", durationMs: 5, ttftMs: 5 });
    hub.observe({ type: "usage", sessionId: "s1", requestId: "r1", promptTokens: null, completionTokens: null, totalTokens: null });
    hub.observe({ type: "error", sessionId: "s1", requestId: "r1", message: "  模型调用失败  \nstack line" });
    await tick();
    expect(seen.at(-1)).toMatchObject({ kind: "failed", message: "模型调用失败" });
    expect(hub.snapshot().recent[0]).toMatchObject({ kind: "failed", message: "模型调用失败" });
  });

  it("an end that does not match the running request leaves the newer run running", () => {
    const hub = new RunActivityHub();
    hub.observe({ type: "turn_started", sessionId: "s1", requestId: "r2" });
    hub.observe({ type: "turn", sessionId: "s1", requestId: "r1", outcome: "aborted", durationMs: 1, ttftMs: 1 });
    expect(hub.snapshot().running.map(run => run.sessionId)).toEqual(["s1"]);
  });

  it("forgets results older than a day, and keeps at most maxRecent", () => {
    const time = clock();
    const hub = new RunActivityHub({ now: time.now, maxRecent: 2 });
    const end = (sessionId: string) => hub.observe({ type: "turn", sessionId, requestId: "r", outcome: "completed", durationMs: 1, ttftMs: 1 });
    end("a");
    time.advance(23 * HOUR);
    end("b");
    end("c");
    expect(hub.snapshot().recent.map(activity => activity.sessionId)).toEqual(["c", "b"]);
    time.advance(2 * HOUR);
    end("d");
    expect(hub.snapshot().recent.map(activity => activity.sessionId)).toEqual(["d", "c"]);
    time.advance(24 * HOUR + 1);
    expect(hub.snapshot().recent).toEqual([]);
  });

  it("a listener that throws does not stop the others, and fan-out survives a failing port", () => {
    const hub = new RunActivityHub();
    const seen: string[] = [];
    hub.subscribe(() => { throw new Error("boom"); });
    hub.subscribe(activity => seen.push(activity.kind));
    const ports = fanOutObservability({ observe: () => { throw new Error("down"); } }, undefined, hub);
    ports.observe({ type: "turn_started", sessionId: "s1", requestId: "r1" });
    expect(seen).toEqual(["started"]);
  });

  it("cuts long messages", () => {
    expect(activityMessage("x".repeat(300))).toHaveLength(200);
    expect(activityMessage("x".repeat(300)).endsWith("…")).toBe(true);
  });
});

describe("ActivityService", () => {
  it("shows a caller only the sessions they can see, with project and title", async () => {
    const hub = new RunActivityHub();
    const visible = new Map([["mine", { projectId: "p1", title: "我的会话" }]]);
    const lookups: string[] = [];
    const service = new ActivityService(hub, async (_owner, sessionId) => { lookups.push(sessionId); return visible.get(sessionId) ?? null; });
    hub.observe({ type: "turn_started", sessionId: "mine", requestId: "r1" });
    hub.observe({ type: "turn_started", sessionId: "theirs", requestId: "r1" });
    for (const requestId of ["a", "b"]) hub.observe({ type: "turn", sessionId: "mine", requestId, outcome: "completed", durationMs: 1, ttftMs: 1 });
    hub.observe({ type: "turn", sessionId: "theirs", requestId: "x", outcome: "completed", durationMs: 1, ttftMs: 1 });

    const snapshot = await service.snapshot("owner");
    expect(snapshot.running).toEqual([expect.objectContaining({ sessionId: "mine", projectId: "p1", title: "我的会话" })]);
    expect(snapshot.recent.map(result => result.sessionId)).toEqual(["mine", "mine"]);
    // One lookup per session per reply.
    expect(lookups.sort()).toEqual(["mine", "theirs"]);

    const [raw] = hub.snapshot().recent;
    expect(await service.view("owner", raw!)).toBeNull();
  });
});
