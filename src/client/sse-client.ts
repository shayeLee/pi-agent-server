// Fetch stream reader + SSE parser + Last-Event-ID reconnection.

import { SseParser } from "./sse.js";
import type { SseEvent } from "./types.js";
import { defaultFetch, resolveHeaders } from "./transport.js";
import type { FetchLike, HeadersProvider } from "./transport.js";

export type SseDecoder = {
  /** Decode bytes, preserving partial character sequences when stream is true. */
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
};

/** `E` is the stream's message type; session streams carry SseEvent. */
export type ConsumeSseOptions<E = SseEvent> = {
  url: string;
  headers?: HeadersProvider;
  /** Optional platform-specific Fetch API implementation. */
  fetch?: FetchLike;
  /** Factory for a platform-specific streaming UTF-8 decoder. Defaults to TextDecoder. */
  createDecoder?: () => SseDecoder;
  /** Event callback; lastEventId is the most recently observed id. */
  onEvent: (event: E, lastEventId: number) => void;
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

/**
 * - "no-live-stream": HTTP 204, the session has no live stream now.
 * - "auth-expired": HTTP 401, or the server sent `auth_expired` before closing (accounts mode,
 *   docs/login-design.md §4). Signing in again is needed; reconnecting would not help.
 */
export type ConsumeSseResult = "no-live-stream" | "auth-expired" | void;

/** The stream could not open: the server answered with this HTTP status. */
export class SseHttpError extends Error {
  constructor(readonly status: number) {
    super(`SSE 连接失败：HTTP ${status}`);
    this.name = "SseHttpError";
  }
}

/** Consume one SSE connection until it ends or is interrupted. */
export async function consumeSse<E = SseEvent>(options: ConsumeSseOptions<E>): Promise<ConsumeSseResult> {
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
  if (res.status === 401) return "auth-expired";
  if (!res.ok || !res.body) {
    throw new SseHttpError(res.status);
  }

  const decoder = (options.createDecoder ?? (() => new TextDecoder()))();
  const reader = res.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  let authExpired = false;
  const dispatchFrames = (chunk: string) => {
    for (const frame of parser.push(chunk)) {
      if (isAborted() || authExpired) break;
      if (frame.id !== null) {
        const id = Number(frame.id);
        if (Number.isFinite(id)) lastEventId = id;
      }
      try {
        const event = JSON.parse(frame.data) as E;
        if ((event as { type?: unknown }).type === "auth_expired") {
          authExpired = true;
          break;
        }
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
    if (epoch) {
      if (options.clientEpoch !== undefined && options.clientEpoch !== epoch) lastEventId = 0;
      options.onEpoch?.(epoch);
    }
    if (isAborted()) return;

    for (;;) {
      const { done, value } = await reader.read();
      if (isAborted() || done) break;
      dispatchFrames(decoder.decode(value, { stream: true }));
      if (authExpired) break;
    }
    if (!isAborted() && !authExpired) dispatchFrames(decoder.decode());
    if (authExpired) {
      cancelReader();
      return "auth-expired";
    }
  } finally {
    options.signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

export type SseConnectionOptions<E = SseEvent> = {
  url: string;
  headers?: HeadersProvider;
  /** Optional platform-specific Fetch API implementation. */
  fetch?: FetchLike;
  /** Factory for a platform-specific streaming UTF-8 decoder. Defaults to TextDecoder. */
  createDecoder?: () => SseDecoder;
  /** Event callback includes the consumed cursor for host-managed session resumption. */
  onEvent: (event: E, lastEventId: number) => void;
  onError?: (error: Error) => void;
  /** Called when the connection opens (including after reconnect). */
  onOpen?: () => void;
  /** Server startup epoch, called when response headers include it. */
  onEpoch?: (epoch: string) => void;
  lastEventId?: number;
  /** Epoch associated with lastEventId, including a previous connection's cursor. */
  initialEpoch?: string;
  /** Called as soon as a stream ends or fails, before reconnect waiting. */
  onDisconnect?: () => void;
  /** First reconnect delay in milliseconds; defaults to 1000. Doubles per consecutive failure. */
  reconnectDelay?: number;
  /** Upper bound for the backed-off reconnect delay; defaults to 30000. */
  maxReconnectDelay?: number;
  /** Called for HTTP 204; no automatic reconnect is attempted. */
  onNoLiveStream?: () => void;
  /** Called when the sign-in ended (HTTP 401 or `auth_expired`); no automatic reconnect is attempted. */
  onAuthExpired?: () => void;
};

/** Establish an auto-reconnecting SSE connection; returns an idempotent close function. */
export function createSseConnection<E = SseEvent>(options: SseConnectionOptions<E>): { close: () => void } {
  const controller = new AbortController();
  let closed = false;
  let lastEventId = options.lastEventId ?? 0;
  let lastEpoch: string | null = options.initialEpoch ?? null;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Exponential backoff while the server stays unreachable; an opened stream starts over.
  let failures = 0;
  const backoff = () => Math.min(options.maxReconnectDelay ?? 30_000, (options.reconnectDelay ?? 1000) * 2 ** failures++);

  async function loop(): Promise<void> {
    while (!closed) {
      try {
        const result = await consumeSse<E>({
          url: options.url,
          headers: options.headers,
          fetch: options.fetch,
          createDecoder: options.createDecoder,
          lastEventId,
          signal: controller.signal,
          clientEpoch: lastEpoch ?? undefined,
          onOpen: () => { failures = 0; options.onOpen?.(); },
          onEvent: (event, id) => {
            lastEventId = id;
            options.onEvent(event, id);
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
        if (result === "auth-expired") {
          // Without a handler, report it like a failure so the stop is not silent.
          if (options.onAuthExpired) options.onAuthExpired();
          else options.onError?.(new Error("SSE 认证失效：需要重新登录"));
          break;
        }
      } catch (error) {
        if (closed) break;
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      options.onDisconnect?.();
      if (closed) break;
      await sleep(backoff());
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
