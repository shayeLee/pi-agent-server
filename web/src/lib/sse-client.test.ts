import { describe, it, expect, vi, afterEach } from "vitest";
import { consumeSse, createSseConnection } from "pi-agent-server/client";

function sseResponse(
  chunks: string[],
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("consumeSse", () => {
  it("解析并分发事件（含 id 追踪）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'id: 1\ndata: {"type":"status","phase":"agent_start"}\n\n',
        'id: 2\ndata: {"type":"completed"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: unknown[] = [];
    const ids: number[] = [];
    await consumeSse({
      url: "http://x/v1/sessions/1/events",
      onEvent: (e, id) => {
        events.push(e);
        ids.push(id);
      },
    });

    expect(events).toEqual([
      { type: "status", phase: "agent_start" },
      { type: "completed" },
    ]);
    expect(ids).toEqual([1, 2]);
  });

  it("默认不发送 Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await consumeSse({ url: "http://x/events", onEvent: () => {} });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("带 lastEventId 时发送 last-event-id header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await consumeSse({
      url: "http://x/events",
      headers: { authorization: "Bearer t" },
      lastEventId: 5,
      onEvent: () => {},
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/events");
    expect((init.headers as Record<string, string>)["last-event-id"]).toBe("5");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
  });

  it("带 clientEpoch 时发送 x-client-epoch header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await consumeSse({
      url: "http://x/events",
      clientEpoch: "epoch-1",
      onEvent: () => {},
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-client-epoch"]).toBe("epoch-1");
  });

  it("响应头带 x-server-epoch 时经 onEpoch 上报", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse([], 200, { "x-server-epoch": "epoch-2" })),
    );

    const epochs: string[] = [];
    await consumeSse({
      url: "http://x/events",
      onEvent: () => {},
      onEpoch: (e) => epochs.push(e),
    });
    expect(epochs).toEqual(["epoch-2"]);
  });

  it("HTTP 204 返回 no-live-stream 正常终态，不触发打开或错误回调", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const onOpen = vi.fn();
    const onError = vi.fn();

    await expect(
      consumeSse({ url: "http://x/events", onEvent: () => {}, onOpen, onError }),
    ).resolves.toBe("no-live-stream");
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("HTTP 非 200 抛错", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([], 401)));
    await expect(
      consumeSse({ url: "http://x/events", onEvent: () => {} }),
    ).rejects.toThrow(/401/);
  });
});

describe("createSseConnection", () => {
  it("sends the initial epoch and resets internal cursors before id-less restart events and reconnect", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(['data: {"type":"completed"}\n\n'], 200, { "x-server-epoch": "B" }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();
    const connection = createSseConnection({ url: "http://x/events", initialEpoch: "A", lastEventId: 100, onEvent, reconnectDelay: 1 });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ "last-event-id": "100", "x-client-epoch": "A" });
      expect(onEvent).toHaveBeenCalledWith({ type: "completed" }, 0);
      expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ "last-event-id": "0", "x-client-epoch": "B" });
    } finally { connection.close(); }
  });
  it("HTTP 204 停止重连并通知 no-live-stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const onNoLiveStream = vi.fn();

    createSseConnection({
      url: "http://x/events",
      onEvent: () => {},
      onNoLiveStream,
      reconnectDelay: 1,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onNoLiveStream).toHaveBeenCalledTimes(1);
  });

  it("HTTP 非 2xx 仍按当前策略重试", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();

    const connection = createSseConnection({
      url: "http://x/events",
      onEvent: () => {},
      onError,
      reconnectDelay: 100,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    connection.close();
  });

  it("网络断开仍按当前策略重试", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();

    const connection = createSseConnection({
      url: "http://x/events",
      onEvent: () => {},
      onError,
      reconnectDelay: 100,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    connection.close();
  });
});

describe("reconnect backoff", () => {
  it("doubles the delay while the server stays unreachable, caps it, and starts over once a stream opens", async () => {
    vi.useFakeTimers();
    let up = false;
    const attempts: number[] = [];
    const fetchMock = vi.fn(async () => {
      attempts.push(Date.now());
      if (!up) throw new Error("ECONNREFUSED");
      return sseResponse([]);
    });
    const connection = createSseConnection({ url: "http://x/events", onEvent: vi.fn(), fetch: fetchMock as unknown as typeof fetch,
      reconnectDelay: 1000, maxReconnectDelay: 8000 });
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 8000);
    const gaps = attempts.slice(1).map((at, i) => at - attempts[i]!);
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 8000]);
    // The server is back: the next stream opens (and ends), so the delay starts over.
    up = true;
    await vi.advanceTimersByTimeAsync(8000);
    const opened = attempts.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts.length).toBe(opened + 1);
    connection.close();
  });
});
