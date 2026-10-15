import { describe, expect, it } from "vitest";
import type { ToolCall } from "pi-agent-server/client";
import { recentActions } from "./useLiveSubagents.js";

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
