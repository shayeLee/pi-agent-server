// Public host API contract v1. This module deliberately re-exports the DTOs used by
// the HTTP composition root so UI consumers do not need to depend on internals.

import type { SubmitInput } from "../application/ports/session-runtime-port.js";
import type { SseEvent as InternalSseEvent } from "../agent/events.js";
import type { AccessCapabilities } from "../server/route-rbac.js";
import type { ModelDescriptor } from "../application/ports/model-catalog-port.js";
import type { ProjectDto, SessionDto } from "../application/session-service.js";

/** `GET /v1/access`. It intentionally contains no role, IP, or token. */
export type Access = AccessCapabilities;
/** A model selectable by the current caller (`GET /v1/models`). */
export type Model = ModelDescriptor;
/** A project returned by the host. */
export type Project = ProjectDto;
/** A session returned by the host; internal persistence fields are excluded. */
export type Session = SessionDto;

/** Input accepted by `POST /v1/sessions/:id/messages`. */
export type MessageInput = Omit<SubmitInput, "userId">;

/** Immediate successful response from a submitted asynchronous message. */
export type SubmitResult =
  | { status: "accepted" }
  | { status: "queued"; position?: number };

/** Legacy message projection. `id`, when supplied by another host, is preserved; Pi transcripts add `sourceId` as the JSONL entry id used by `timeline.messageId`. */
export type ExportMessage = { role: string; text: string; sourceId?: string; id?: string; images?: Array<{ mediaType: string; base64: string }> };
/** Block-ordered timeline item returned by `GET /v1/sessions/:id/export`. */
export type ExportTimelineItem =
  | { id: string; type: "message"; role: "user" | "assistant"; messageId: string; turnId: string | null; text: string; order: number; timestamp?: string }
  | { id: string; type: "tool_call"; messageId: string; turnId: string | null; callId: string; toolCallId: string; toolName: string; args: unknown; status: "completed" | "error" | "no_result"; order: number; timestamp?: string }
  | { id: string; type: "tool_result"; messageId: string | null; turnId: string | null; callId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean; order: number; timestamp?: string }
  | { id: string; type: "system_event"; event: "model_failback"; from: string; to: string; reason: string; order: number; timestamp?: string };
/** Read-only session snapshot returned by `GET /v1/sessions/:id/export`. `timeline` is additive; Pi `messages[].sourceId` exactly joins `timeline[].messageId`. */
export type Export = { messages: ExportMessage[]; timeline: ExportTimelineItem[]; lastEventId: number };
/** Owner/session-scoped UTF-8 text preview. `path` is always project-relative; no root is client supplied. */
export type FilePreview = { path: string; content: string; lineCount: number; requestedLine?: number };

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
export { TURN_ERROR_CODES } from "../application/ports/session-runtime-port.js";

/** The twelve event discriminants supported by SSE v1. */
export const SSE_EVENT_TYPES = [
  "text_delta",
  "thinking_delta",
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
