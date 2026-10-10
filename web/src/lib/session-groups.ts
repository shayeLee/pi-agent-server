import type { SessionRecord } from "pi-agent-server/client";
import type { MessageKey } from "../i18n/messages.js";

export type SessionTimeGroup = "today" | "yesterday" | "week" | "older";

const GROUP_ORDER: SessionTimeGroup[] = ["today", "yesterday", "week", "older"];

export function sessionTimeGroup(updatedAt: number, now = Date.now()): SessionTimeGroup {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "older";
  const startOfDay = (time: number) => {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const todayStart = startOfDay(now);
  const updatedStart = startOfDay(updatedAt);
  const dayMs = 86_400_000;
  if (updatedStart >= todayStart) return "today";
  if (updatedStart >= todayStart - dayMs) return "yesterday";
  if (updatedStart >= todayStart - 7 * dayMs) return "week";
  return "older";
}

export function groupSessionsByTime(sessions: SessionRecord[], now = Date.now()): { key: SessionTimeGroup; sessions: SessionRecord[] }[] {
  const buckets = new Map<SessionTimeGroup, SessionRecord[]>();
  for (const session of sessions) {
    const key = sessionTimeGroup(session.updatedAt, now);
    const list = buckets.get(key) ?? [];
    list.push(session);
    buckets.set(key, list);
  }
  return GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({ key, sessions: buckets.get(key)! }));
}

export const sessionGroupLabelKey: Record<SessionTimeGroup, MessageKey> = {
  today: "nav.sessionGroup.today",
  yesterday: "nav.sessionGroup.yesterday",
  week: "nav.sessionGroup.week",
  older: "nav.sessionGroup.older",
};
