import { describe, expect, it } from "vitest";
import type { ToolCall } from "pi-agent-server/client";
import { latestReply, recentActions } from "./useLiveSubagents.js";

const call = (id: string, done: boolean): ToolCall => ({ toolCallId: id, toolName: "read", args: { path: `/src/${id}.ts` }, partialResult: undefined, result: undefined, isError: false, done });

describe("recentActions", () => {
  it("keeps only the last three persisted tool steps, oldest first", () => {
    const timeline = [
      { kind: "message", id: "m" },
      ...["a", "b", "c", "d"].map((id, index) => ({ kind: "tool", id, call: call(id, index < 3) })),
    ];
    const actions = recentActions(timeline);
    expect(actions.map(action => action.id)).toEqual(["b", "c", "d"]);
    expect(actions[2]).toMatchObject({ toolName: "read", done: false });
    expect(actions[2].summary).toContain("/src/d.ts");
  });
});

describe("latestReply", () => {
  it("returns the last non-empty line of the newest assistant text with its streaming state", () => {
    const timeline = [
      { kind: "message", id: "u", role: "user", text: "task" },
      { kind: "message", id: "a1", role: "assistant", text: "older reply", streaming: false },
      { kind: "tool", id: "t" },
      { kind: "message", id: "a2", role: "assistant", text: "first line\n\n  second line  \n", streaming: true },
    ];
    expect(latestReply(timeline)).toEqual({ text: "second line", streaming: true });
  });
  it("skips empty assistant text and has nothing without assistant text", () => {
    const trailingBlank = [{ kind: "message", id: "a1", role: "assistant", text: "done", streaming: false },
      { kind: "message", id: "a2", role: "assistant", text: "  \n", streaming: true }];
    expect(latestReply(trailingBlank)).toEqual({ text: "done", streaming: false });
    const userOnly = [{ kind: "message", id: "u", role: "user", text: "task" }];
    expect(latestReply(userOnly)).toBeUndefined();
  });
});
