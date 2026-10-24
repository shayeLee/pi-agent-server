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
    onInvalidSession: vi.fn(), setConnection: vi.fn(), onLoad: vi.fn(), rememberFirstPrompt: vi.fn(), onEvent: vi.fn(),
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

function streamOptions(setConnection: (value: unknown) => void): Parameters<typeof useSessionStream>[0] {
  return {
    api: new ApiClient({ baseUrl: "" }), activeSessionId: "s1", navigationGeneration: 0,
    isCurrent: () => true, chatStore: createChatStore(),
    newlyCreatedIdsRef: { current: new Set(["s1"]) }, historyReadySessionIdsRef: { current: new Set() },
    emptyHistoryIdsRef: { current: new Set() }, eventCursorsRef: { current: new Map() }, usageRevisionRef: { current: new Map() },
    setHistoryReadySessionIds: vi.fn(), setUsageSnapshots: vi.fn(), setInvalidContexts: vi.fn(),
    onInvalidSession: vi.fn(), setConnection, onLoad: vi.fn(), rememberFirstPrompt: vi.fn(), onEvent: vi.fn(),
  };
}

it("reports connecting until the stream opens, and reconnecting only after an open stream drops", async () => {
  let respond!: (response: Response) => void;
  let finish!: () => void;
  const fetcher = vi.fn()
    // A new session's runtime is created on this first request; it answers late.
    .mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve; }))
    .mockImplementation(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const states: unknown[] = [];
  const hook = renderHook(useSessionStream, { initialProps: streamOptions(value => states.push(value)) });
  try {
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(states).toEqual(["connecting"]);
    respond(new Response(new ReadableStream<Uint8Array>({ start(controller) { finish = () => controller.close(); } })));
    await waitFor(() => expect(states.at(-1)).toBe("open"));
    finish();
    await waitFor(() => expect(states.at(-1)).toBe("reconnecting"));
    expect(states).toEqual(["connecting", "open", "reconnecting"]);
  } finally { hook.unmount(); }
});

it("treats the server's 204 as no live stream, not as a dropped connection", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const states: unknown[] = [];
  const hook = renderHook(useSessionStream, { initialProps: streamOptions(value => states.push(value)) });
  try {
    await waitFor(() => expect(states.at(-1)).toBe("no-live"));
    expect(states).not.toContain("reconnecting");
  } finally { hook.unmount(); }
});

it("reports an ended login once and stops, then reconnects when the same account signs back in", async () => {
  let authorized = false;
  const fetcher = vi.fn(async (url: string) => {
    if (!authorized) return new Response(JSON.stringify({ code: "auth_required" }), { status: 401 });
    if (!url.endsWith("/events")) return new Response(JSON.stringify({ messages: [], lastEventId: 0 }));
    return new Response(new ReadableStream<Uint8Array>({ start() {} }));
  });
  vi.stubGlobal("fetch", fetcher);
  const onAuthExpired = vi.fn();
  const states: unknown[] = [];
  const options = { ...streamOptions(value => states.push(value)), onAuthExpired, authGeneration: 0 };
  const hook = renderHook(useSessionStream, { initialProps: options });
  try {
    await waitFor(() => expect(onAuthExpired).toHaveBeenCalledOnce());
    expect(states.at(-1)).toBe("reconnecting");
    // No retry loop against a server that has said the login is over.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fetcher).toHaveBeenCalledTimes(1);

    authorized = true;
    act(() => hook.rerender({ ...options, authGeneration: 1 }));
    await waitFor(() => expect(states.at(-1)).toBe("open"));
    expect(onAuthExpired).toHaveBeenCalledOnce();
  } finally { hook.unmount(); }
});
