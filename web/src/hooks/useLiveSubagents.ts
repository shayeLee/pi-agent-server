import type { SubagentRun, ToolCall } from "pi-agent-server/client";
import { toolHeader } from "../tools/metadata.js";

/** A running child for the inline panel; fed by `useSubagents`, which owns all subagent polling. */
export type LiveSubagent = {
  run: SubagentRun;
  /** Most recent child tool steps from the persisted transcript, oldest first. */
  actions: { id: string; toolName: string; summary: string; done: boolean }[];
};

const MAX_ACTIONS = 3;

export function recentActions(timeline: readonly { kind: string; id: string; call?: ToolCall }[]): LiveSubagent["actions"] {
  return timeline.filter((item): item is { kind: "tool"; id: string; call: ToolCall } => item.kind === "tool" && Boolean(item.call))
    .slice(-MAX_ACTIONS)
    .map(item => ({ id: item.id, toolName: item.call.toolName, summary: toolHeader(item.call).summary, done: item.call.done }));
}
