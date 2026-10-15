import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiClient, createChatStore, createSseConnection } from "pi-agent-server/client";
import { useSessionStream } from "./useSessionStream.js";

vi.mock("pi-agent-server/client", async original => ({
  ...await original<typeof import("pi-agent-server/client")>(),
  createSseConnection: vi.fn(() => ({ close: vi.fn() })),
}));
function fixture(): Parameters<typeof useSessionStream>[0] {
  return {
    api: new ApiClient({ baseUrl: "" }), activeSessionId: "s1", navigationGeneration: 0, isCurrent: () => true, chatStore: createChatStore(),
    newlyCreatedIdsRef: { current: new Set() }, historyReadySessionIdsRef: { current: new Set() },
    emptyHistoryIdsRef: { current: new Set() }, eventCursorsRef: { current: new Map() }, usageRevisionRef: { current: new Map() },
    setHistoryReadySessionIds: vi.fn(), setUsageSnapshots: vi.fn(), setInvalidContexts: vi.fn(),
    onInvalidSession: vi.fn(), setConnection: vi.fn(), onLoad: vi.fn(), rememberFirstPrompt: vi.fn(), onEvent: vi.fn(),
  };
}
beforeEach(() => {
  vi.mocked(createSseConnection).mockClear();
  vi.spyOn(ApiClient.prototype, "exportSession").mockResolvedValue({ messages: [], timeline: [], lastEventId: 7 });
});
afterEach(() => vi.restoreAllMocks());

it("does not reconnect or replace subscribing callbacks on unrelated renders; closes and ignores late events", async () => {
  const options = fixture();
  const { rerender, unmount } = renderHook(useSessionStream, { initialProps: options });
  await waitFor(() => expect(createSseConnection).toHaveBeenCalledOnce());
  const connection = vi.mocked(createSseConnection).mock.calls[0]![0];
  const nextOnEvent = vi.fn();
  rerender({ ...options, onEvent: nextOnEvent });
  expect(createSseConnection).toHaveBeenCalledOnce();
  const event = { type: "completed" as const, requestId: "r1" };
  act(() => connection.onEvent(event, 8));
  expect(options.onEvent).toHaveBeenCalledWith("s1", options.chatStore, event);
  expect(nextOnEvent).not.toHaveBeenCalled();
  expect(options.eventCursorsRef.current.get("s1")).toBe(8);
  const close = vi.mocked(createSseConnection).mock.results[0]!.value.close;
  unmount();
  expect(close).toHaveBeenCalledOnce();
  act(() => connection.onEvent(event, 9));
  expect(options.eventCursorsRef.current.get("s1")).toBe(8);
  expect(options.onEvent).toHaveBeenCalledOnce();
});

it("invokes authoritative refresh on every open including reconnect, but not after close", async () => {
  const options = { ...fixture(), onOpen: vi.fn() };
  const { unmount } = renderHook(useSessionStream, { initialProps: options });
  await waitFor(() => expect(createSseConnection).toHaveBeenCalledOnce());
  const connection = vi.mocked(createSseConnection).mock.calls[0]![0];
  act(() => { connection.onOpen?.(); connection.onDisconnect?.(); connection.onOpen?.(); });
  expect(options.onOpen).toHaveBeenCalledTimes(2);
  unmount();
  act(() => connection.onOpen?.());
  expect(options.onOpen).toHaveBeenCalledTimes(2);
});

it("cancels a pending export on deselection without restoring history or creating a connection", async () => {
  let resolve!: (value: Awaited<ReturnType<ApiClient["exportSession"]>>) => void;
  vi.mocked(ApiClient.prototype.exportSession).mockReturnValue(new Promise(yes => { resolve = yes; }));
  const options = fixture();
  const initialState = options.chatStore.getState();
  const { rerender } = renderHook(useSessionStream, { initialProps: options });
  rerender({ ...options, activeSessionId: null });
  await act(async () => resolve({ messages: [{ role: "user", text: "late" }], timeline: [], lastEventId: 20 }));
  expect(options.chatStore.getState().timeline).toEqual(initialState.timeline);
  expect(createSseConnection).not.toHaveBeenCalled();
  expect(options.historyReadySessionIdsRef.current.size).toBe(0);
  expect(options.rememberFirstPrompt).not.toHaveBeenCalled();
});

it("starts newly created sessions at zero without export, and resumes cached sessions at the consumed cursor", async () => {
  const options = fixture();
  options.newlyCreatedIdsRef.current.add("s1");
  const { rerender } = renderHook(useSessionStream, { initialProps: options });
  await waitFor(() => expect(createSseConnection).toHaveBeenCalledOnce());
  expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
  const connection = vi.mocked(createSseConnection).mock.calls[0]![0];
  expect(connection.lastEventId).toBe(0);
  expect(options.newlyCreatedIdsRef.current.has("s1")).toBe(false);
  act(() => connection.onEvent({ type: "completed", requestId: "r1" }, 3));
  rerender({ ...options, activeSessionId: null });
  rerender(options);
  await waitFor(() => expect(createSseConnection).toHaveBeenCalledTimes(2));
  expect(vi.mocked(createSseConnection).mock.calls[1]![0].lastEventId).toBe(3);
});


it("resets authority and cursors on restart reconnect, remembers epochs across selection, and ignores old SSE", async () => {
  const options = { ...fixture(), onEpochReset: vi.fn() };
  const hook = renderHook(useSessionStream, { initialProps: options });
  await waitFor(() => expect(createSseConnection).toHaveBeenCalledOnce());
  const old = vi.mocked(createSseConnection).mock.calls[0]![0];
  act(() => { old.onOpen?.(); old.onEpoch?.("server-a"); old.onEvent({ type: "completed", requestId: "r1" }, 20); });
  expect(options.onEpochReset).toHaveBeenCalledOnce();
  act(() => { old.onDisconnect?.(); old.onOpen?.(); old.onEpoch?.("server-a"); });
  expect(options.onEpochReset).toHaveBeenCalledOnce();
  act(() => { old.onDisconnect?.(); old.onOpen?.(); old.onEpoch?.("server-b"); });
  expect(options.onEpochReset).toHaveBeenCalledTimes(2);
  expect(options.eventCursorsRef.current.get("s1")).toBe(0);
  act(() => old.onEvent({ type: "completed", requestId: "r2" }, 1));
  expect(options.eventCursorsRef.current.get("s1")).toBe(1);
  hook.rerender({ ...options, activeSessionId: null }); hook.rerender(options);
  await waitFor(() => expect(createSseConnection).toHaveBeenCalledTimes(2));
  const next = vi.mocked(createSseConnection).mock.calls[1]![0];
  act(() => { next.onEpoch?.("server-b"); old.onEpoch?.("server-a"); old.onEvent({ type: "completed", requestId: "old" }, 99); });
  expect(options.onEpochReset).toHaveBeenCalledTimes(2);
  expect(options.eventCursorsRef.current.get("s1")).toBe(1);
  act(() => next.onEpoch?.("server-c"));
  expect(options.onEpochReset).toHaveBeenCalledTimes(3);
});
