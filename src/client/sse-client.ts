// Fetch stream reader + SSE parser + Last-Event-ID reconnection.

import { SseParser } from "./sse.js";
import type { SseEvent } from "./types.js";
import { defaultFetch, resolveHeaders } from "./transport.js";
import type { FetchLike, HeadersProvider } from "./transport.js";

export type SseDecoder = {
  /** Decode bytes, preserving partial character sequences when stream is true. */
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
};

export type ConsumeSseOptions = {
  url: string;
  headers?: HeadersProvider;
  /** Optional platform-specific Fetch API implementation. */
  fetch?: FetchLike;
  /** Factory for a platform-specific streaming UTF-8 decoder. Defaults to TextDecoder. */
  createDecoder?: () => SseDecoder;
  /** Event callback; lastEventId is the most recently observed id. */
  onEvent: (event: SseEvent, lastEventId: number) => void;
  onError?: (error: Error) => void;
  /** Called when response headers arrive. */
  onOpen?: () => void;
  /** Server startup epoch (used to detect server restart on reconnect). */
  onEpoch?: (epoch: string) => void;
  /** Known server epoch; sent to let the server ignore stale cursors after restart. */
  clientEpoch?: string;
  /** Resume cursor (0 means replay from the beginning). */
  lastEventId?: number;
  signal?: AbortSignal;
};

export type ConsumeSseResult = "no-live-stream" | void;

/** Consume one SSE connection until it ends or is interrupted. */
export async function consumeSse(options: ConsumeSseOptions): Promise<ConsumeSseResult> {
  const parser = new SseParser();
  const isAborted = () => options.signal?.aborted === true;
  let lastEventId = options.lastEventId ?? 0;
  if (isAborted()) return;

  const resolvedHeaders = resolveHeaders(options.headers);
  const headers = resolvedHeaders instanceof Promise ? await resolvedHeaders : resolvedHeaders;
  if (isAborted()) return;
  // Always send last-event-id (including 0) to ask the server to replay buffered events.
  headers["last-event-id"] = String(lastEventId);
  // The server ignores an old cursor when its epoch changed after a restart.
  if (options.clientEpoch !== undefined) {
    headers["x-client-epoch"] = options.clientEpoch;
  }

  const fetcher = options.fetch ?? defaultFetch;
  const res = await fetcher(options.url, { headers, signal: options.signal });
  if (isAborted()) return;
  // 204 means this session has no live stream currently; it is a normal terminal result.
  if (res.status === 204) return "no-live-stream";
  if (!res.ok || !res.body) {
    throw new Error(`SSE 连接失败：HTTP ${res.status}`);
  }

  const decoder = (options.createDecoder ?? (() => new TextDecoder()))();
  const reader = res.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  const dispatchFrames = (chunk: string) => {
    for (const frame of parser.push(chunk)) {
      if (isAborted()) break;
      if (frame.id !== null) {
        const id = Number(frame.id);
        if (Number.isFinite(id)) lastEventId = id;
      }
      try {
        const event = JSON.parse(frame.data) as SseEvent;
        if (!isAborted()) options.onEvent(event, lastEventId);
      } catch {
        if (!isAborted()) options.onError?.(new Error(`无法解析 SSE data：${frame.data}`));
      }
    }
  };
  options.signal?.addEventListener("abort", cancelReader, { once: true });
  if (isAborted()) cancelReader();
  try {
    if (isAborted()) return;
    options.onOpen?.();
    if (isAborted()) return;

    const epoch = res.headers.get("x-server-epoch");
    if (epoch) options.onEpoch?.(epoch);
    if (isAborted()) return;

    for (;;) {
      const { done, value } = await reader.read();
      if (isAborted() || done) break;
      dispatchFrames(decoder.decode(value, { stream: true }));
    }
    if (!isAborted()) dispatchFrames(decoder.decode());
  } finally {
    options.signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

export type SseConnectionOptions = {
  url: string;
  headers?: HeadersProvider;
  /** Optional platform-specific Fetch API implementation. */
  fetch?: FetchLike;
  /** Factory for a platform-specific streaming UTF-8 decoder. Defaults to TextDecoder. */
  createDecoder?: () => SseDecoder;
  onEvent: (event: SseEvent) => void;
  onError?: (error: Error) => void;
  /** Called when the connection opens (including after reconnect). */
  onOpen?: () => void;
  /** Server startup epoch, called when response headers include it. */
  onEpoch?: (epoch: string) => void;
  lastEventId?: number;
  /** Reconnect delay in milliseconds; defaults to 1000. */
  reconnectDelay?: number;
  /** Called for HTTP 204; no automatic reconnect is attempted. */
  onNoLiveStream?: () => void;
};

/** Establish an auto-reconnecting SSE connection; returns an idempotent close function. */
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
          fetch: options.fetch,
          createDecoder: options.createDecoder,
          lastEventId,
          signal: controller.signal,
          clientEpoch: lastEpoch ?? undefined,
          onOpen: options.onOpen,
          onEvent: (event, id) => {
            lastEventId = id;
            options.onEvent(event);
          },
          onError: options.onError,
          onEpoch: (epoch) => {
            // Event ids restart from 1 after server restart; discard the old local cursor.
            if (lastEpoch !== null && lastEpoch !== epoch) {
              lastEventId = 0;
            }
            lastEpoch = epoch;
            options.onEpoch?.(epoch);
          },
        });
        if (closed) break;
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
