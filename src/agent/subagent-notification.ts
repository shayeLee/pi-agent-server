import type { NotificationEvent } from "../shared/events.js";
export type { SubagentNotification, NotificationEvent } from "../shared/events.js";
export function notificationFromEntry(value: unknown): NotificationEvent | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.type !== "custom" || entry.customType !== "agent-team:notification" ||
      typeof entry.id !== "string" || !entry.id || typeof entry.timestamp !== "string") return null;
  const data = entry.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1 ||
      typeof data.notificationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.notificationId) ||
      typeof data.text !== "string" || !Array.isArray(data.runIds) || !data.runIds.length ||
      !data.runIds.every(id => typeof id === "string" && id.length > 0)) return null;
  return { type: "notification", version: 1, notificationId: data.notificationId,
    runIds: [...data.runIds] as string[], text: data.text, entryId: entry.id, timestamp: entry.timestamp };
}
