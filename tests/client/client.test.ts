import { describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  consumeSse,
  createSseConnection,
  createChatStore,
  type FetchLike,
  type SseEvent,
} from "../../src/client/index.js";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

describe("framework-neutral Agent Server client", () => {
  it("injects URL resolution, per-request authentication, headers, and fetch", async () => {
    let token = "first";
    const fetchMock: FetchLike = vi.fn(async () => jsonResponse([]));
    const api = new ApiClient({
      resolveUrl: (path) => `native://agent${path}`,
      headers: () => ({ "x-host": "test" }),
      token: () => token,
      fetch: fetchMock,
    });

    await api.listSessions();
    token = "second";
    await api.listSessions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = vi.mocked(fetchMock).mock.calls[0]!;
    const [secondUrl, secondInit] = vi.mocked(fetchMock).mock.calls[1]!;
    expect(firstUrl).toBe("native://agent/v1/sessions");
    expect((firstInit?.headers as Record<string, string>)).toMatchObject({
      "x-host": "test",
      authorization: "Bearer first",
    });
    expect((secondInit?.headers as Record<string, string>).authorization).toBe("Bearer second");
  });

  it("consumes SSE through an injected Fetch API implementation and decoder", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: 7\ndata: {"type":"completed"}\n\n'));
        controller.close();
      },
    });
    const fetchMock: FetchLike = vi.fn(async () => new Response(stream));
    const events: string[] = [];
    const textDecoder = new TextDecoder();
    const decode = vi.fn((input?: Uint8Array, options?: { stream?: boolean }) =>
      textDecoder.decode(input, options),
    );

    await consumeSse({
      url: "native://agent/events",
      fetch: fetchMock,
      createDecoder: () => ({ decode }),
      headers: { authorization: "Bearer native" },
      onEvent: (event, id) => events.push(`${event.type}:${id}`),
    });

    expect(events).toEqual(["completed:7"]);
    expect(decode).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "native://agent/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer native",
          "last-event-id": "0",
        }),
      }),
    );
  });

  it("does not start a fetch when a connection closes during async header resolution", async () => {
    let resolveHeaders!: (headers: HeadersInit) => void;
    let markHeadersStarted!: () => void;
    const headersStarted = new Promise<void>((resolve) => {
      markHeadersStarted = resolve;
    });
    const headers = new Promise<HeadersInit>((resolve) => {
      resolveHeaders = resolve;
    });
    const fetchMock: FetchLike = vi.fn(async () => new Response(null, { status: 204 }));
    const onOpen = vi.fn();
    const onEvent = vi.fn();
    const onNoLiveStream = vi.fn();

    const connection = createSseConnection({
      url: "native://agent/events",
      headers: () => {
        markHeadersStarted();
        return headers;
      },
      fetch: fetchMock,
      onEvent,
      onOpen,
      onNoLiveStream,
    });
    await headersStarted;
    connection.close();
    resolveHeaders({});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onNoLiveStream).not.toHaveBeenCalled();
  });

  it("suppresses callbacks when fetch resolves after close", async () => {
    let resolveFetch!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock: FetchLike = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
          markFetchStarted();
        }),
    );
    const callbacks = {
      onOpen: vi.fn(),
      onEpoch: vi.fn(),
      onEvent: vi.fn(),
      onNoLiveStream: vi.fn(),
    };
    const connection = createSseConnection({
      url: "native://agent/events",
      fetch: fetchMock,
      ...callbacks,
    });
    await fetchStarted;
    connection.close();
    resolveFetch(new Response(null, { status: 204 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(callbacks.onEpoch).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.onNoLiveStream).not.toHaveBeenCalled();
  });

  it("does not report open or epoch when a successful fetch resolves after close", async () => {
    let resolveFetch!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock: FetchLike = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
          markFetchStarted();
        }),
    );
    const onOpen = vi.fn();
    const onEpoch = vi.fn();
    const onEvent = vi.fn();
    const connection = createSseConnection({
      url: "native://agent/events",
      fetch: fetchMock,
      onOpen,
      onEpoch,
      onEvent,
    });
    await fetchStarted;
    connection.close();
    resolveFetch(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"completed"}\n\n'));
            controller.close();
          },
        }),
        { headers: { "x-server-epoch": "epoch-late" } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpen).not.toHaveBeenCalled();
    expect(onEpoch).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("suppresses a late stream event after close", async () => {
    let resolveRead!: (result: ReadableStreamReadResult<Uint8Array>) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const reader = {
      read: vi.fn(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            resolveRead = resolve;
            markReadStarted();
          }),
      ),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const response = {
      status: 200,
      ok: true,
      headers: new Headers({ "x-server-epoch": "epoch-1" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    const onOpen = vi.fn();
    const onEpoch = vi.fn();
    const onEvent = vi.fn();
    const connection = createSseConnection({
      url: "native://agent/events",
      fetch: vi.fn(async () => response),
      onOpen,
      onEpoch,
      onEvent,
    });
    await readStarted;
    connection.close();
    resolveRead({
      done: false,
      value: new TextEncoder().encode('id: 1\ndata: {"type":"completed"}\n\n'),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onEpoch).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("supports history restoration and failed-send rollback through shared store actions", () => {
    const store = createChatStore();
    const history = [
      {
        kind: "message" as const,
        id: "hist-0",
        role: "assistant" as const,
        text: "restored answer",
        streaming: false,
      },
    ];

    store.restoreHistory(history);
    store.setError("temporary error");
    expect(store.getState().error).toBe("temporary error");
    store.setError(null);
    store.addUserMessage("question", "pending-1");
    store.rollbackUserMessage("pending-1", "send failed");

    expect(store.getState()).toMatchObject({
      timeline: history,
      phase: "idle",
      error: "send failed",
    });

    const unchanged = store.getState();
    store.rollbackUserMessage("pending-1", "stale failure");
    expect(store.getState()).toBe(unchanged);
  });

  it("ignores model failback and unknown events without changing store state", () => {
    const store = createChatStore();
    store.addUserMessage("question", "m1");
    store.applyEvent({ type: "status", phase: "turn_start" });
    const before = store.getState();

    const failbackStart: SseEvent = {
      type: "model_failback",
      phase: "start",
      attemptId: "attempt-1",
      from: "provider/model-a",
      requestId: "request-1",
    };
    const failbackEnd: SseEvent = {
      type: "model_failback",
      phase: "end",
      attemptId: "attempt-1",
      outcome: "switched",
      from: "provider/model-a",
      to: "provider/model-b",
      reason: "unavailable",
      requestId: "request-1",
    };

    expect(store.applyEvent(failbackStart)).toBe(before);
    expect(store.applyEvent(failbackEnd)).toBe(before);

    const unknownEvent = { type: "future_event", payload: "ignored" } as unknown as SseEvent;
    expect(store.applyEvent(unknownEvent)).toBe(before);
    expect(store.getState()).toBe(before);
  });

  it("provides a framework-neutral store for user and SSE state transitions", () => {
    const store = createChatStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener, { emitCurrent: true });

    store.addUserMessage("question", "m1");
    store.applyEvent({ type: "text_delta", text: "answer" });
    store.applyEvent({ type: "completed" });

    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.getState()).toMatchObject({
      phase: "completed",
      timeline: [
        { kind: "message", id: "m1", role: "user", text: "question" },
        { kind: "message", role: "assistant", text: "answer", streaming: false },
      ],
    });

    unsubscribe();
    store.reset();
    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.getState().phase).toBe("idle");
  });
});
