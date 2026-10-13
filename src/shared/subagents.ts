import type { TimelineItem } from "../client/types.js";

export const SUBAGENT_TRANSCRIPT = "agent-team:transcript";
export type SubagentStatus = "running" | "completed" | "failed" | "stopped" | "unknown";
export type SubagentRun = {
  id: string; runId: string; agent: string; task: string; startedAt: number; endedAt?: number;
  status: SubagentStatus; model?: string; thinkingLevel?: string; revision: number; streamRevision?: number; legacy?: boolean;
};
export type SubagentInput = {
  id: string; text: string; timestamp: number; kind: "initial" | "steer";
  delivery: "submitted" | "delivered" | "failed" | "unknown";
};
export type SubagentConversation = {
  run: SubagentRun; timeline: TimelineItem[]; inputs: SubagentInput[];
  /** Original SDK messages, including non-text content and tool-result details. */
  messages: unknown[];
};
export type SubagentSnapshot = { sessionId: string; runs: SubagentRun[]; conversation?: SubagentConversation };
