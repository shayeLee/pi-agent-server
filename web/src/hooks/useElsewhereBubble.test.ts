import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ActivityEvent } from "pi-agent-server/client";
import { ELSEWHERE_BUBBLE_MS, useElsewhereBubble } from "./useElsewhereBubble.js";

const ended = (id: number, sessionId: string, kind: "completed" | "failed" | "aborted" = "completed"): ActivityEvent =>
  ({ id, at: id, sessionId, projectId: "p2", title: `会话 ${sessionId}`, kind, durationMs: 1 });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const onOpen = vi.fn();
  const hook = renderHook(({ latest, active }) => useElsewhereBubble(latest, active, onOpen),
    { initialProps: { latest: null as ActivityEvent | null, active: "open" as string | null } });
  return { onOpen, ...hook };
}

describe("useElsewhereBubble", () => {
  it("picks up another session that completed or failed, not the open one or a stopped run", () => {
    const { result, rerender } = setup();
    rerender({ latest: ended(1, "open"), active: "open" });
    rerender({ latest: ended(2, "other", "aborted"), active: "open" });
    expect(result.current).toBeNull();
    rerender({ latest: ended(3, "other", "failed"), active: "open" });
    expect(result.current?.result).toMatchObject({ sessionId: "other", kind: "failed" });
  });

  it("stays for its time even when a run starts elsewhere, and opening it ends it", () => {
    const { result, rerender, onOpen } = setup();
    rerender({ latest: ended(1, "other"), active: "open" });
    rerender({ latest: { id: 2, at: 2, sessionId: "x", projectId: "p1", title: "x", kind: "started" }, active: "open" });
    act(() => { vi.advanceTimersByTime(ELSEWHERE_BUBBLE_MS - 1); });
    expect(result.current).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBeNull();

    rerender({ latest: ended(3, "other"), active: "open" });
    act(() => result.current!.open());
    expect(onOpen).toHaveBeenCalledWith("p2", "other");
    expect(result.current).toBeNull();
  });

  it("goes when that session is opened some other way", () => {
    const { result, rerender } = setup();
    rerender({ latest: ended(1, "other"), active: "open" });
    rerender({ latest: ended(1, "other"), active: "other" });
    expect(result.current).toBeNull();
  });
});
