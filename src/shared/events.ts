// Pure wire types shared by the server and browser clients.
import type { UsageSnapshot } from "../core/usage-snapshot.js";

/** Dedicated durable display marker; never infer notifications from user text. */
export type SubagentNotification = {
  version: 1;
  notificationId: string;
  runIds: string[];
  text: string;
};
export type NotificationEvent = SubagentNotification & {
  type: "notification";
  entryId: string;
  timestamp: string;
  requestId?: never;
};

/** Character-based delivery estimate, never SDK token usage. */
export type ModelOutputProgress = {
  ordinal: number;
  phase: "start" | "delta" | "end";
  tokensPerSecondEstimate: number | null;
  includesThinking: boolean;
  /** SSE replay must not renew model activity. */
  replay?: boolean;
  /** Age of the last source delta at publication (trailing flush is not new output). */
  activityAgeMs?: number;
  /** Total tokens of this prompt's completed model calls so far; null before the first completes or when unknown. */
  promptTokens?: number | null;
};

export type CompactionReason = "manual" | "threshold" | "overflow";
/** Pure metadata: never contains summaries or SDK errors. */
export type CompactionState = {
  status: "running" | "succeeded" | "failed" | "aborted" | "unknown";
  reason: CompactionReason;
  requestId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  willRetry?: boolean;
};

/** Turn correlation; optional only for legacy/non-turn events. */
export type SseRequestId = { readonly requestId?: string };
export type SseEvent =
  | NotificationEvent
  | ({ type: "compaction_start"; reason: CompactionReason; replay?: boolean } & SseRequestId)
  | ({ type: "compaction_end"; reason: CompactionReason; outcome: "succeeded" | "failed" | "aborted"; willRetry: boolean; tokensBefore?: number; tokensAfter?: number; replay?: boolean } & SseRequestId)
  | ({ type: "control_queue" } & import("./control-queue.js").ControlQueueSnapshot)
  /** The session-steps projection moved (coalesced): read GET /steps. Carries no step content; session-level, never request-owned. */
  | ({ type: "steps_changed"; projectionId: string; revision: number } & SseRequestId)
  /** Subagent records or live output moved (coalesced): read GET /subagents. Carries no run data; session-level. */
  | ({ type: "subagents_changed"; revision: number } & SseRequestId)
  | ({ type: "steering_consumed" } & import("./steering.js").SteeringConsumed)
  | ({ type: "model_output_progress" } & ModelOutputProgress & SseRequestId)
  | ({ type: "text_delta"; text: string } & SseRequestId)
  | ({ type: "thinking_delta"; text: string } & SseRequestId)
  | ({ type: "tool_start"; toolCallId: string; toolName: string; args: unknown } & SseRequestId)
  | ({ type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown } & SseRequestId)
  | ({ type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs?: number | null } & SseRequestId)
  | ({ type: "status"; phase: "agent_start" | "turn_start"; execution?: import("../core/usage-snapshot.js").ExecutionSnapshot | null } & SseRequestId)
  | ({ type: "queued"; position?: number } & SseRequestId)
  | ({ type: "usage"; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; durationMs: number; ttftMs: number } & UsageSnapshot & SseRequestId)
  | ({ type: "model_failback"; phase: "start" | "end"; attemptId: string; outcome?: "switched" | "no-target" | "failed" | "cancelled"; from?: string; to?: string; reason?: string } & SseRequestId)
  | ({ type: "error"; message: string } & SseRequestId)
  | ({ type: "completed" } & SseRequestId)
  | ({ type: "aborted" } & SseRequestId);
