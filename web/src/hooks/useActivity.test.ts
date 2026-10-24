import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ActivityResult, ActivityStreamMessage } from "pi-agent-server/client";

type Options = { url: string; onEvent: (message: ActivityStreamMessage) => void; onError?: (error: Error) => void; onAuthExpired?: () => void };
const connections = vi.hoisted(() => [] as (Options & { close: ReturnType<typeof vi.fn> })[]);
vi.mock("pi-agent-server/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("pi-agent-server/client")>(),
  createSseConnection: (options: Options) => {
    const close = vi.fn();
    connections.push({ ...options, close });
    return { close };
  },
}));

import { SseHttpError } from "pi-agent-server/client";
import { ACTIVITY_RECENT_KEEP, applyActivityMessage, useActivity } from "./useActivity.js";

const result = (id: number, sessionId = "s1"): ActivityResult => ({ id, at: id, sessionId, projectId: "p1", title: `会话 ${sessionId}`, kind: "completed", durationMs: 1 });

afterEach(() => { connections.length = 0; });

describe("applyActivityMessage", () => {
  it("a snapshot replaces what is known; a live change updates running, recent and latest", () => {
    let state = applyActivityMessage({ running: new Map(), recent: [result(9, "old")], latest: null }, {
      type: "activity_snapshot", running: [{ sessionId: "s1", projectId: "p1", title: "一", startedAt: 1 }], recent: [result(1, "s0")],
    });
    expect([...state.running.keys()]).toEqual(["s1"]);
    expect(state.recent.map(item => item.sessionId)).toEqual(["s0"]);
    expect(state.latest).toBeNull();

    state = applyActivityMessage(state, { type: "activity", event: { id: 2, at: 5, sessionId: "s2", projectId: "p2", title: "二", kind: "started" } });
    expect([...state.running.keys()]).toEqual(["s1", "s2"]);
    expect(state.latest).toMatchObject({ sessionId: "s2", kind: "started" });

    state = applyActivityMessage(state, { type: "activity", event: { ...result(3, "s1"), kind: "failed", message: "坏了" } });
    expect([...state.running.keys()]).toEqual(["s2"]);
    expect(state.recent.map(item => item.id)).toEqual([3, 1]);
    expect(state.latest).toMatchObject({ kind: "failed", message: "坏了" });
  });

  it("keeps a bounded list of results", () => {
    let state = applyActivityMessage({ running: new Map(), recent: [], latest: null }, { type: "activity_snapshot", running: [], recent: [] });
    for (let id = 1; id <= ACTIVITY_RECENT_KEEP + 5; id++) state = applyActivityMessage(state, { type: "activity", event: result(id) });
    expect(state.recent).toHaveLength(ACTIVITY_RECENT_KEEP);
    expect(state.recent[0]!.id).toBe(ACTIVITY_RECENT_KEEP + 5);
  });
});

describe("useActivity", () => {
  it("follows the activity stream, and a new login starts over on a new connection", () => {
    const onAuthExpired = vi.fn();
    const { result: hook, rerender, unmount } = renderHook(({ generation }) => useActivity({ authGeneration: generation, onAuthExpired }), { initialProps: { generation: 0 } });
    expect(connections.map(connection => connection.url)).toEqual(["/v1/activity/events"]);
    act(() => connections[0]!.onEvent({ type: "activity_snapshot", running: [{ sessionId: "s1", projectId: "p1", title: "一", startedAt: 1 }], recent: [] }));
    expect(hook.current.running.size).toBe(1);
    connections[0]!.onAuthExpired?.();
    expect(onAuthExpired).toHaveBeenCalledOnce();

    rerender({ generation: 1 });
    expect(connections[0]!.close).toHaveBeenCalledOnce();
    expect(connections).toHaveLength(2);
    expect(hook.current.running.size).toBe(0);
    unmount();
    expect(connections[1]!.close).toHaveBeenCalledOnce();
  });

  it("stops on a server without the activity feed, and keeps retrying other failures", () => {
    renderHook(() => useActivity({}));
    connections[0]!.onError?.(new SseHttpError(502));
    expect(connections[0]!.close).not.toHaveBeenCalled();
    connections[0]!.onError?.(new SseHttpError(404));
    expect(connections[0]!.close).toHaveBeenCalledOnce();
  });
});
