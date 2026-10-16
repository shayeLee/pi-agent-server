import type { SubagentRun, ToolCall } from "pi-agent-server/client";
import { toolHeader } from "../tools/metadata.js";

/** A running child for the inline panel; fed by `useSubagents`, which owns all subagent polling. */
export type LiveSubagent = {
  run: SubagentRun;
  /** Most recent child tool steps from the persisted transcript, oldest first. */
  actions: { id: string; toolName: string; summary: string; done: boolean }[];
  /** Last non-empty line of the child's newest assistant text; the panel shows it on one line. */
  reply?: { text: string; streaming: boolean };
};

const MAX_ACTIONS = 3;

export function recentActions(timeline: readonly { kind: string; id: string; call?: ToolCall }[]): LiveSubagent["actions"] {
  return timeline.filter((item): item is { kind: "tool"; id: string; call: ToolCall } => item.kind === "tool" && Boolean(item.call))
    .slice(-MAX_ACTIONS)
    .map(item => ({ id: item.id, toolName: item.call.toolName, summary: toolHeader(item.call).summary, done: item.call.done }));
}

/** The newest assistant text's last non-empty line: while it streams, that is where it grows. */
export function latestReply(timeline: readonly { kind: string; role?: string; text?: string; streaming?: boolean }[]): LiveSubagent["reply"] {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.kind !== "message" || item.role !== "assistant") continue;
    const line = (item.text ?? "").split("\n").map(part => part.trim()).filter(Boolean).at(-1);
    if (line) return { text: line, streaming: item.streaming === true };
  }
  return undefined;
}
