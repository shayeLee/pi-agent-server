// SSE 帧格式化（needs.md §4.2）：事件带递增 id，data 为 JSON 事件体，空行分隔帧。
// 客户端以 id 作为 Last-Event-ID 断线续传基准。

import type { SseEvent } from "../agent/events.js";

export function formatSseEvent(id: number, event: SseEvent): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}
