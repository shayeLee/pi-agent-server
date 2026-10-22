import type { TimelineItem } from "../client/types.js";

export const SUBAGENT_TRANSCRIPT = "agent-team:transcript";
export type SubagentStatus = "running" | "completed" | "failed" | "stopped" | "unknown";
export type SubagentRun = {
  id: string; runId: string; agent: string; task: string; startedAt: number; endedAt?: number;
  backend?: "pi" | "claude"; canSteer?: boolean;
  status: SubagentStatus; model?: string; thinkingLevel?: string; revision: number; streamRevision?: number; legacy?: boolean;
};
export type SubagentInput = {
  id: string; text: string; timestamp: number; kind: "initial" | "steer";
  /** Who sent it: the parent agent ("host") or a person through the host UI ("user"). */
  source: "host" | "user";
  delivery: "submitted" | "delivered" | "failed" | "unknown";
};
export type SubagentConversation = {
  run: SubagentRun; timeline: TimelineItem[]; inputs: SubagentInput[];
  /** Original SDK messages, including non-text content and tool-result details. */
  messages: unknown[];
};
/** Why a person's steer was not taken; "unavailable" means the session offers no subagent control. */
export type SubagentSteerReason = "not-found" | "not-running" | "no-channel" | "failed" | "invalid";
export type SubagentSteerAck = { ok: true } | { ok: false; reason: SubagentSteerReason };
export type SubagentSnapshot = { sessionId: string; runs: SubagentRun[]; conversation?: SubagentConversation };
