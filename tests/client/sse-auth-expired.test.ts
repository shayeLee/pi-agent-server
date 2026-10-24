// The SSE client stops instead of reconnecting when the sign-in ended (docs/login-design.md §9).
import { describe, expect, it, vi } from "vitest";
import { consumeSse, createSseConnection } from "../../src/client/sse-client.js";

function sse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status, headers: { "content-type": "text/event-stream" } });
}

describe("auth expiry on the SSE client", () => {
  it("consumeSse reports auth-expired for HTTP 401", async () => {
    const result = await consumeSse({ url: "http://x/events", fetch: async () => new Response("{}", { status: 401 }), onEvent: () => {} });
    expect(result).toBe("auth-expired");
  });

  it("consumeSse stops at auth_expired and does not hand it to onEvent", async () => {
    const events: unknown[] = [];
    const result = await consumeSse({
      url: "http://x/events",
      fetch: async () => sse(['id: 1\ndata: {"type":"completed"}\n\ndata: {"type":"auth_expired"}\n\nid: 2\ndata: {"type":"completed"}\n\n']),
      onEvent: event => events.push(event),
    });
    expect(result).toBe("auth-expired");
    expect(events).toEqual([{ type: "completed" }]);
  });

  it("other failures still throw, so the connection keeps reconnecting", async () => {
    await expect(consumeSse({ url: "http://x/events", fetch: async () => new Response("", { status: 503 }), onEvent: () => {} })).rejects.toThrow(/503/);
  });

  it("createSseConnection calls onAuthExpired once and does not reconnect", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    const onAuthExpired = vi.fn();
    const onError = vi.fn();
    const connection = createSseConnection({ url: "http://x/events", fetch, onEvent: () => {}, onAuthExpired, onError, reconnectDelay: 1 });
    await vi.waitFor(() => expect(onAuthExpired).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    connection.close();
  });

  it("without onAuthExpired the stop is reported through onError", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    const onError = vi.fn();
    const connection = createSseConnection({ url: "http://x/events", fetch, onEvent: () => {}, onError, reconnectDelay: 1 });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain("重新登录");
    connection.close();
  });
});
