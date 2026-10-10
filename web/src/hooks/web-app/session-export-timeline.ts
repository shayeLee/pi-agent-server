import type { TimelineItem } from "pi-agent-server/client";
import { readMessageImages } from "../../message-images.js";
import { toolDurationMs } from "../../../../src/shared/tool-duration.js";

export function projectExportTimeline(raw: readonly unknown[], messages: readonly unknown[]): TimelineItem[] {
  const imagesBySource = new Map<string, ReturnType<typeof readMessageImages>>();
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (row.role === "user" && typeof row.sourceId === "string") imagesBySource.set(row.sourceId, readMessageImages(row.images));
  }
  const items: TimelineItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (row.type === "notification" && row.version === 1 && typeof row.notificationId === "string" && typeof row.entryId === "string" && typeof row.text === "string" && Array.isArray(row.runIds) && row.runIds.every(id => typeof id === "string")) {
      const id = `notification:${row.notificationId}`;
      if (!items.some(item => item.id === id)) items.push({ kind: "notification", id, version: 1, notificationId: row.notificationId, entryId: row.entryId, text: row.text, runIds: row.runIds as string[], timestamp: String(row.timestamp ?? "") });
    } else if (row.type === "message" && (row.role === "user" || row.role === "assistant") && typeof row.text === "string") {
      const timestamp = typeof row.timestamp === "string" && row.timestamp ? row.timestamp : undefined;
      items.push({ kind: "message", id: row.role === "user" && typeof row.messageId === "string" ? `history-message:${row.messageId}` : `history-${String(row.id ?? items.length)}`,
        role: row.role, text: row.text, streaming: false,
        ...(timestamp ? { timestamp } : {}),
        ...(row.role === "user" && typeof row.messageId === "string" ? { images: imagesBySource.get(row.messageId) } : {}) } as TimelineItem);
    } else if (row.type === "thinking" && typeof row.text === "string") {
      items.push({ kind: "thinking", id: `history-${String(row.id ?? items.length)}`,
        text: row.text, streaming: false });
    } else if (row.type === "tool_call" && typeof row.toolCallId === "string" && typeof row.toolName === "string") {
      items.push({ kind: "tool", id: `history-${String(row.id ?? items.length)}`, call: {
        toolCallId: row.toolCallId, toolName: row.toolName, args: row.args,
        partialResult: undefined, result: undefined, isError: row.status === "error", done: false,
      } });
    } else if (row.type === "tool_result" && typeof row.toolCallId === "string") {
      let index = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item?.kind === "tool" && item.call.toolCallId === row.toolCallId) { index = i; break; }
      }
      const durationMs = toolDurationMs(row.durationMs);
      const duration = durationMs !== undefined ? { durationMs } : {};
      if (index >= 0) {
        const previous = items[index];
        if (previous?.kind === "tool") items[index] = { ...previous, call: {
          ...previous.call, result: row.result, isError: row.isError === true, done: true, ...duration,
        } };
      } else {
        items.push({ kind: "tool", id: `history-${String(row.id ?? items.length)}`, call: {
          toolCallId: row.toolCallId, toolName: String(row.toolName ?? "工具"), args: undefined,
          partialResult: undefined, result: row.result, isError: row.isError === true, done: true, ...duration,
        } });
      }
    }
  }
  return items;
}
