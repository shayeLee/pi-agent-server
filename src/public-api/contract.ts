// Public host API contract v1. Only pure shared DTOs cross this boundary.
import type { SseEvent as InternalSseEvent } from "../shared/events.js";
import type { AccessCapabilities, ModelDescriptor, ProjectDto, SessionDto } from "../shared/api-types.js";

/** `GET /v1/access`. It intentionally contains no role, IP, or token. */
export type Access = AccessCapabilities;
/** A model selectable by the current caller (`GET /v1/models`). */
export type Model = ModelDescriptor;
/** A project returned by the host. */
export type Project = ProjectDto;
/** A session returned by the host; internal persistence fields/source paths are excluded.
 * Optional visibility/origin distinguish native shared sessions; absent means private/managed.
 * Shared access still requires network admission, existing RBAC, and current cwd policy.
 */
export type Session = SessionDto;
/** Authorized read-only prompt with provenance; live effective may not yet be sent. */
export type { SessionStepKind, SessionStep, SessionStepsSnapshot } from "../shared/session-steps.js";
export type { SessionSystemPrompt } from "../shared/system-prompt.js";

/** Input accepted by `POST /v1/sessions/:id/messages`. */
export type { MessageInput } from "../shared/api-types.js";

/** Correlated steer identity; HTTP 202 only admits it, SSE confirms SDK consumption. */
export type { SteeringIdentity, SteeringInput } from "../shared/steering.js";
export type { ControlIdentity, ControlQueueItem, ControlQueueSnapshot } from "../shared/control-queue.js";
export type SteeringConsumed = Extract<InternalSseEvent, { type: "steering_consumed" }>;

/** Immediate successful response from a submitted asynchronous message. */
export type SubmitResult =
  | { status: "accepted" }
  | { status: "queued"; position?: number };

/** Legacy message projection. `id`, when supplied by another host, is preserved; Pi transcripts add `sourceId` as the JSONL entry id used by `timeline.messageId`. */
export type ExportMessage = { role: string; text: string; sourceId?: string; id?: string; images?: Array<{ mediaType: string; base64: string }> };
/** Block-ordered timeline item returned by `GET /v1/sessions/:id/export`. */
export type ExportTimelineItem =
  | (Omit<import("../shared/events.js").NotificationEvent, "type" | "requestId"> & { id: string; type: "notification"; order: number })
  | { id: string; type: "message"; role: "user" | "assistant"; messageId: string; turnId: string | null; text: string; order: number; timestamp?: string; stopReason?: "aborted" }
  | { id: string; type: "thinking"; messageId: string; turnId: string | null; text: string; order: number; timestamp?: string }
  | { id: string; type: "tool_call"; messageId: string; turnId: string | null; callId: string; toolCallId: string; toolName: string; args: unknown; status: "completed" | "error" | "no_result"; order: number; timestamp?: string }
  | { id: string; type: "tool_result"; messageId: string | null; turnId: string | null; callId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs?: number | null; nestedCalls?: import("../shared/nested-tool-calls.js").NestedToolCalls; order: number; timestamp?: string }
  | { id: string; type: "system_event"; event: "model_failback"; from: string; to: string; reason: string; order: number; timestamp?: string }
  | (Omit<import("../shared/events.js").CommandOutputEvent, "type" | "requestId"> & { id: string; type: "command_output"; order: number });
/** Read-only session snapshot returned by `GET /v1/sessions/:id/export`. `timeline` is additive; Pi `messages[].sourceId` exactly joins `timeline[].messageId`. */
export type { UsageSnapshot, UsageTokens, LastResponseUsage, ExecutionSnapshot, PromptUsage, SubagentUsage } from "../core/usage-snapshot.js";
export type Export = { messages: ExportMessage[]; timeline: ExportTimelineItem[]; lastEventId: number; compaction?: import("../shared/events.js").CompactionState; usageSnapshot?: import("../core/usage-snapshot.js").UsageSnapshot };
/** Owner/session-scoped UTF-8 text preview. `path` is always project-relative; no root is client supplied. */
export type FilePreview = { path: string; content: string; lineCount: number; requestedLine?: number };
/** `@` path suggestions, `/` command menu and host command results (`/v1/sessions/:id/files` and `/commands`). */
export type { ProjectFileEntry, ProjectFileSearch, SessionCommandInfo, SessionCommandList, SessionCommandInput, SessionCommandName, SessionCommandResult, CommandOutputLine, CommandPrompt, CommandPromptAnswer } from "../shared/commands.js";

/** Stable error envelope used by HTTP error responses. */
export type ApiError = { statusCode: number; error: string; message: string; code?: string };

/** JSON `data:` payload carried by the session SSE stream. */
export type SseEvent = InternalSseEvent;

/**
 * `runTurn` 预算超限的稳定 error code。**这是唯一权威定义**，同时通过
 * `pi-agent-server/contract` 静态导出给同机消费者，并经 `PluginHostContext.turnErrorCodes`
 * 注入给插件（插件不能静态 import 宿主包，见 plugin/contract.ts）。
 * 命名不可随意变更：插件与测试据此判定终态原因。
 */
export { TURN_ERROR_CODES } from "../shared/api-types.js";

/** Event discriminants supported by SSE v1 (additive optional progress). */
export const SSE_EVENT_TYPES = [
  "compaction_start",
  "compaction_end",
  "notification",
  "command_output",
  "command_prompt",
  "command_prompt_closed",
  "steering_consumed",
  "control_queue",
  "steps_changed",
  "subagents_changed",
  "title_changed",
  "text_delta",
  "thinking_delta",
  "model_output_progress",
  "tool_start",
  "tool_update",
  "tool_end",
  "status",
  "queued",
  "usage",
  "model_failback",
  "error",
  "completed",
  "aborted",
] as const;

export type { SubagentRun, SubagentSnapshot, SubagentConversation, SubagentInput } from "../shared/subagents.js";
