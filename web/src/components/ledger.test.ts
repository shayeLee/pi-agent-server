import { describe, expect, it } from "vitest";
import type { TimelineItem } from "pi-agent-server/client";
import { groupLedger, previewText, workDurationMs } from "./ledger.js";

const user = (id: string, timestamp?: string): TimelineItem => ({ kind: "message", id, role: "user", text: id, streaming: false, ...(timestamp ? { timestamp } : {}) });
const text = (id: string): TimelineItem => ({ kind: "message", id, role: "assistant", text: id, streaming: false });
const think = (id: string, body = "plan"): TimelineItem => ({ kind: "thinking", id, text: body, streaming: false });
const tool = (id: string, extra: Partial<Extract<TimelineItem, { kind: "tool" }>> = {}): TimelineItem => ({ kind: "tool", id,
  call: { toolCallId: id, toolName: "bash", args: {}, partialResult: undefined, result: undefined, isError: false, done: true }, ...extra });

describe("groupLedger", () => {
  it("splits user, assistant and system entries without reordering", () => {
    const notice: TimelineItem = { kind: "notification", id: "n1", version: 1, notificationId: "n1", entryId: "e", text: "done", runIds: ["1"], timestamp: "" };
    const entries = groupLedger([user("u1"), text("a1"), tool("t1"), notice, user("u2"), text("a2")]);
    expect(entries.map(entry => entry.role)).toEqual(["user", "assistant", "system", "user", "assistant"]);
    const flat = entries.flatMap(entry => entry.segments.flatMap(segment => segment.kind === "work" ? segment.items.map(item => item.id) : [segment.item.id]));
    expect(flat).toEqual(["u1", "a1", "t1", "n1", "u2", "a2"]);
  });

  it("forms a work block only from runs that contain a tool, keeping interleaved thinking", () => {
    const [, reply] = groupLedger([user("u"), think("k0"), text("a1"), think("k1"), tool("t1"), think("k2"), tool("t2"), text("a2")]);
    expect(reply.segments.map(segment => segment.kind === "work" ? `work[${segment.items.map(item => item.id).join(",")}]` : segment.item.id))
      .toEqual(["k0", "a1", "work[k1,t1,k2,t2]", "a2"]);
  });

  it("skips blank thinking and keeps recorded or observed time from the first timed item", () => {
    const observed = new Map([["a1", "2026-10-14T01:02:03.000Z"]]);
    const entries = groupLedger([user("u", "2026-10-14T01:00:00.000Z"), think("blank", "  "), text("a1")], observed);
    expect(entries[0].timestamp).toBe("2026-10-14T01:00:00.000Z");
    expect(entries[1].timestamp).toBe("2026-10-14T01:02:03.000Z");
    expect(entries[1].segments).toHaveLength(1);
  });
});

describe("work block helpers", () => {
  it("reports wall time only when both ends carry real times", () => {
    const first = tool("t1", { timestamp: "2026-10-14T00:00:00.000Z" }) as Extract<TimelineItem, { kind: "tool" }>;
    const last = { ...tool("t2", { timestamp: "2026-10-14T00:05:00.000Z" }), call: { ...(tool("t2") as Extract<TimelineItem, { kind: "tool" }>).call, durationMs: 18_000 } } as Extract<TimelineItem, { kind: "tool" }>;
    expect(workDurationMs([first, last])).toBe(318_000);
    expect(workDurationMs([tool("x") as Extract<TimelineItem, { kind: "tool" }>, last])).toBeNull();
  });

  it("previews whitespace-normalised text", () => {
    expect(previewText("a\n\n  b", 60)).toBe("a b");
    expect(previewText("x".repeat(70), 60)).toHaveLength(61);
  });
});
