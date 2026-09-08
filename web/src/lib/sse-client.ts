// SSE 客户端：fetch 流式读取 + 帧解析 + Last-Event-ID 断线重连（needs.md §4.2）。
// 与 EventSource 不同，这里用 fetch 以便携带 Authorization header 与 last-event-id。

import { SseParser } from "./sse.js";
import type { SseEvent } from "../types.js";

export type ConsumeSseOptions = {
  url: string;
  headers?: Record<string, string>;
  /** 事件回调；lastEventId 为该事件的最新 id。 */
  onEvent: (event: SseEvent, lastEventId: number) => void;
  onError?: (error: Error) => void;
  /** 连接建立（响应头到达）后触发。 */
  onOpen?: () => void;
  /** 服务端启动纪元上报（用于重连检测重启）。 */
  onEpoch?: (epoch: string) => void;
  /** 客户端已知的服务端纪元（重连时携带，供服务端检测重启后忽略旧 cursor）。 */
  clientEpoch?: string;
  /** 断线续传基准（0 表示从头补发）。 */
  lastEventId?: number;
  signal?: AbortSignal;
};

export type ConsumeSseResult = "no-live-stream" | void;

/** 消费一次 SSE 连接直到结束或中断。 */
export async function consumeSse(options: ConsumeSseOptions): Promise<ConsumeSseResult> {
  const parser = new SseParser();
  let lastEventId = options.lastEventId ?? 0;

  const headers: Record<string, string> = { ...options.headers };
  // 总是发送 last-event-id（含 0），让服务端从头补发已缓冲事件；不发送会被当作「只收新事件」
  headers["last-event-id"] = String(lastEventId);
  // 携带已知纪元，服务端检测到与自身不一致时忽略旧 cursor（服务重启后事件 ID 已重置）
  if (options.clientEpoch !== undefined) {
    headers["x-client-epoch"] = options.clientEpoch;
  }

  const res = await fetch(options.url, { headers, signal: options.signal });
  // 204 表示该会话当前没有可用的实时流，是正常终态而不是可重试的断线。
  if (res.status === 204) return "no-live-stream";
  if (!res.ok || !res.body) {
    throw new Error(`SSE 连接失败：HTTP ${res.status}`);
  }

  // 连接已建立（响应头到达），上报以供 UI 展示连接状态
  options.onOpen?.();

  // 上报服务端启动纪元（用于重连时检测重启导致的事件 ID 重置）
  const epoch = res.headers.get("x-server-epoch");
  if (epoch) options.onEpoch?.(epoch);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const frame of parser.push(chunk)) {
        if (frame.id !== null) {
          const id = Number(frame.id);
          if (Number.isFinite(id)) lastEventId = id;
        }
        try {
          options.onEvent(JSON.parse(frame.data) as SseEvent, lastEventId);
        } catch {
          options.onError?.(new Error(`无法解析 SSE data：${frame.data}`));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type SseConnectionOptions = {
  url: string;
  headers?: Record<string, string>;
  onEvent: (event: SseEvent) => void;
  onError?: (error: Error) => void;
  /** 连接建立后触发（含重连成功）。 */
  onOpen?: () => void;
  lastEventId?: number;
  /** 重连延迟（毫秒），默认 1000。 */
  reconnectDelay?: number;
  /** 服务端明确表示当前没有实时流（HTTP 204）时触发，不会自动重连。 */
  onNoLiveStream?: () => void;
};

/** 建立带自动重连的 SSE 连接；返回 close 函数（幂等）。 */
export function createSseConnection(options: SseConnectionOptions): { close: () => void } {
  const controller = new AbortController();
  let closed = false;
  let lastEventId = options.lastEventId ?? 0;
  let lastEpoch: string | null = null;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function loop(): Promise<void> {
    while (!closed) {
      try {
        const result = await consumeSse({
          url: options.url,
          headers: options.headers,
          lastEventId,
          signal: controller.signal,
          clientEpoch: lastEpoch ?? undefined,
          onOpen: options.onOpen,
          onEvent: (_event, id) => {
            lastEventId = id;
            options.onEvent(_event);
          },
          onError: options.onError,
          onEpoch: (epoch) => {
            // 服务重启后事件 ID 从 1 重置；本地 cursor 置 0（服务端也会因 epoch 不一致忽略旧 cursor）
            if (lastEpoch !== null && lastEpoch !== epoch) {
              lastEventId = 0;
            }
            lastEpoch = epoch;
          },
        });
        if (result === "no-live-stream") {
          options.onNoLiveStream?.();
          break;
        }
      } catch (error) {
        if (closed) break;
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      if (closed) break;
      await sleep(options.reconnectDelay ?? 1000);
    }
  }

  void loop();

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}
