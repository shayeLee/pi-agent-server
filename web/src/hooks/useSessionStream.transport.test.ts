import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, createChatStore } from "pi-agent-server/client";
import { useSessionStream } from "./useSessionStream.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["A", "B"])("resumes selection with cursor AND known epoch when the server is %s", async epoch => {
  let serverEpoch = "A";
  const requests: Record<string, string>[] = [];
  const encoder = new TextEncoder();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/events")) return new Response(JSON.stringify({ messages: [], lastEventId: 0 }));
    const headers = init?.headers as Record<string, string>;
    requests.push({ ...headers });
    const cursor = headers["x-client-epoch"] && headers["x-client-epoch"] !== serverEpoch
      ? 0 : Number(headers["last-event-id"]);
    const ids = serverEpoch === "B" ? [1, 2, 3, 4, 5] : [100, 101];
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      // First selection consumes 100; returning in the same epoch must only replay 101.
      for (const id of (requests.length === 1 ? [100] : ids).filter(id => id > cursor)) {
        controller.enqueue(encoder.encode(`id: ${id}\ndata: {"type":"completed","requestId":"r${id}"}\n\n`));
      }
    } });
    return new Response(stream, { headers: { "x-server-epoch": serverEpoch } });
  });
  vi.stubGlobal("fetch", fetcher);
  const options: Parameters<typeof useSessionStream>[0] = {
    api: new ApiClient({ baseUrl: "" }), activeSessionId: "s1", navigationGeneration: 0,
    isCurrent: () => true, chatStore: createChatStore(),
    newlyCreatedIdsRef: { current: new Set() }, historyReadySessionIdsRef: { current: new Set() },
    emptyHistoryIdsRef: { current: new Set() }, eventCursorsRef: { current: new Map() }, usageRevisionRef: { current: new Map() },
    setHistoryReadySessionIds: vi.fn(), setUsageSnapshots: vi.fn(), setInvalidContexts: vi.fn(),
    onInvalidSession: vi.fn(), setConnected: vi.fn(), onLoad: vi.fn(), rememberFirstPrompt: vi.fn(), onEvent: vi.fn(),
  };
  const hook = renderHook(useSessionStream, { initialProps: options });
  try {
    await waitFor(() => expect(options.eventCursorsRef.current.get("s1")).toBe(100));
    act(() => hook.rerender({ ...options, activeSessionId: null }));
    serverEpoch = epoch;
    act(() => hook.rerender(options));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ "last-event-id": "100", "x-client-epoch": "A" });
    await waitFor(() => expect(options.eventCursorsRef.current.get("s1")).toBe(epoch === "B" ? 5 : 101));
    expect(vi.mocked(options.onEvent).mock.calls.map(call => call[2].requestId)).toEqual(
      epoch === "B" ? ["r100", "r1", "r2", "r3", "r4", "r5"] : ["r100", "r101"],
    );
  } finally { hook.unmount(); }
});
