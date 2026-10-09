import type { SubagentNotification } from "./subagent-notification.js";

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
