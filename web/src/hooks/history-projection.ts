import { zhCN } from "../i18n/zh-CN.js";
import type { TimelineItem } from "pi-agent-server/client";
import { readMessageImages } from "../message-images.js";
import { toolDurationMs } from "../../../src/shared/tool-duration.js";
import { readNestedToolCalls } from "../../../src/shared/nested-tool-calls.js";

/** Project exported history without changing transport or live-store ownership. */
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
    const recorded = typeof row.timestamp === "string" && row.timestamp ? { timestamp: row.timestamp } : {};
    if (row.type === "notification" && row.version === 1 && typeof row.notificationId === "string" && typeof row.entryId === "string" && typeof row.text === "string" && Array.isArray(row.runIds) && row.runIds.every(id => typeof id === "string")) {
      const id = `notification:${row.notificationId}`;
      if (!items.some(item => item.id === id)) items.push({ kind: "notification", id, version: 1, notificationId: row.notificationId, entryId: row.entryId, text: row.text, runIds: row.runIds as string[], timestamp: String(row.timestamp ?? "") });
    } else if (row.type === "command_output" && row.version === 1 && typeof row.name === "string" && typeof row.args === "string" && typeof row.entryId === "string"
        && typeof row.failed === "boolean" && Array.isArray(row.output)) {
      const id = `command:${row.entryId}`;
      const output = row.output.filter((line): line is { level: "info" | "warning" | "error"; text: string } =>
        !!line && typeof line === "object" && typeof (line as { text?: unknown }).text === "string"
        && ["info", "warning", "error"].includes((line as { level?: unknown }).level as string));
      if (!items.some(item => item.id === id)) items.push({ kind: "command", id, version: 1, name: row.name, args: row.args, output, failed: row.failed,
        entryId: row.entryId, timestamp: String(row.timestamp ?? "") });
    } else if (row.type === "message" && (row.role === "user" || row.role === "assistant") && typeof row.text === "string") {
      items.push({ kind: "message", id: row.role === "user" && typeof row.messageId === "string" ? `history-message:${row.messageId}` : `history-${String(row.id ?? items.length)}`,
        role: row.role, text: row.text, streaming: false, ...recorded,
        ...(row.role === "assistant" && row.stopReason === "aborted" ? { stopReason: "aborted" as const } : {}),
        ...(row.role === "user" && typeof row.messageId === "string" ? { images: imagesBySource.get(row.messageId) } : {}) });
    } else if (row.type === "thinking" && typeof row.text === "string") {
      items.push({ kind: "thinking", id: `history-${String(row.id ?? items.length)}`,
        text: row.text, streaming: false, ...recorded });
    } else if (row.type === "tool_call" && typeof row.toolCallId === "string" && typeof row.toolName === "string") {
      items.push({ kind: "tool", id: `history-${String(row.id ?? items.length)}`, ...recorded, call: {
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
      const nestedCalls = readNestedToolCalls(row.nestedCalls);
      const duration = { ...(durationMs !== undefined ? { durationMs } : {}), ...(nestedCalls ? { nested: nestedCalls } : {}) };
      if (index >= 0) {
        const previous = items[index];
        if (previous?.kind === "tool") items[index] = { ...previous, call: {
          ...previous.call, result: row.result, isError: row.isError === true, done: true, ...duration,
        } };
      } else {
        items.push({ kind: "tool", id: `history-${String(row.id ?? items.length)}`, call: {
          toolCallId: row.toolCallId, toolName: String(row.toolName ?? zhCN.errors.toolFallback), args: undefined,
          partialResult: undefined, result: row.result, isError: row.isError === true, done: true, ...duration,
        } });
      }
    }
  }
  return items;
}

export function projectLegacyHistory(messages: unknown): TimelineItem[] {
  return (Array.isArray(messages) ? messages : [])
    .filter(
      (message): message is { role: string; text: string; images?: unknown; sourceId?: string } =>
        typeof message === "object" &&
        message !== null &&
        typeof (message as { text?: unknown }).text === "string",
    )
    .map((message, index) => ({
      kind: "message" as const,
      id: message.role === "user" && typeof message.sourceId === "string" ? `history-message:${message.sourceId}` : `hist-${index}`,
      role: (message.role === "user" ? "user" : "assistant") as "user" | "assistant",
      text: message.text,
      ...(message.role === "user" ? { images: readMessageImages(message.images) } : {}),
      streaming: false,
    }));
}
