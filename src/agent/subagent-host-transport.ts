import type { SubagentNotification } from "./subagent-notification.js";
import type { SubagentSteerAck, SubagentSteerReason } from "../shared/subagents.js";

/** Session-local capability, not a public HTTP/SDK API. ACK means admission, never turn completion. */
export const SUBAGENT_HOST_TRANSPORT_EVENT = "agent-team:host-transport";
export type AdmissionAck =
  | { accepted: true; mode: "followUp" | "pending" | "run" | "queued"; requestId: string }
  | { accepted: false; reason: "notready" | "disposed" | "cancelled" | "busy" | "full" | "invalid" | "failed" };
export type SubagentHostTransport = { post(payload: SubagentNotification): Promise<AdmissionAck> };
export type SubagentHostTransportHandshake = { version: 1; accept(transport: SubagentHostTransport): void };
export function isSubagentHostTransportHandshake(value: unknown): value is SubagentHostTransportHandshake {
  return typeof value === "object" && value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { accept?: unknown }).accept === "function";
}
/**
 * Session-local control the agent-team extension hands the host at session_start: a person's
 * steer for a running child, addressed by transcript id. ok means the control socket took the
 * message, never that the child received it; delivery shows in the transcript.
 */
export const SUBAGENT_HOST_CONTROL_EVENT = "agent-team:host-control";
export type SubagentHostControl = { version: 1; steer(transcriptId: string, text: string): Promise<SubagentSteerAck> };
export type { SubagentSteerAck };
export function isSubagentHostControl(value: unknown): value is SubagentHostControl {
  return typeof value === "object" && value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { steer?: unknown }).steer === "function";
}
const STEER_REASONS: readonly string[] = ["not-found", "not-running", "no-channel", "failed", "invalid"];
/** An extension answer is untrusted shape: anything but a known ack reads as a failed send. */
export function steerAck(value: unknown): SubagentSteerAck {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "failed" };
  const ack = value as { ok?: unknown; reason?: unknown };
  if (ack.ok === true) return { ok: true };
  return { ok: false, reason: typeof ack.reason === "string" && STEER_REASONS.includes(ack.reason) ? ack.reason as SubagentSteerReason : "failed" };
}
export type ExtensionCustomMessage = {
  customType: "agent-team:results-ready";
  content: string;
  display: false;
  details: { version: 1; notificationId: string };
};
export function notificationMessage(payload: SubagentNotification): ExtensionCustomMessage {
  return { customType: "agent-team:results-ready", content: payload.text, display: false,
    details: { version: 1, notificationId: payload.notificationId } };
}
export function validNotification(payload: unknown): payload is SubagentNotification {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as SubagentNotification;
  return p.version === 1 && typeof p.notificationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.notificationId) &&
    typeof p.text === "string" && Array.isArray(p.runIds) && p.runIds.length > 0 &&
    p.runIds.every(id => typeof id === "string" && id.length > 0);
}
