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

/** Read-only session snapshot returned by `GET /v1/sessions/:id/export`. */
export type Export = { messages: unknown; lastEventId: number };

/** Stable error envelope used by HTTP error responses. */
export type ApiError = { statusCode: number; error: string; message: string; code?: string };

/** JSON `data:` payload carried by the session SSE stream. */
export type SseEvent = InternalSseEvent;

/** The eleven event discriminants supported by SSE v1. */
export const SSE_EVENT_TYPES = [
  "text_delta",
  "thinking_delta",
  "tool_start",
  "tool_update",
  "tool_end",
  "status",
  "queued",
  "usage",
  "error",
  "completed",
  "aborted",
] as const;
