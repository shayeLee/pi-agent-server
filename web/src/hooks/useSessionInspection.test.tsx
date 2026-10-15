import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, SessionStepsSnapshot } from "pi-agent-server/client";
import { useSessionInspection } from "./useSessionInspection.js";

const snapshot = (sessionId = "a", revision = 1, projectionId = "p", count = 1): SessionStepsSnapshot => ({
  sessionId, revision, projectionId, steps: Array.from({ length: count }, (_, i) => ({
    id: `${i}`, kind: "thinking", content: `delta ${i}`, status: "streaming", source: "observed",
  })),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function setup() {
  const getSessionSteps = vi.fn().mockResolvedValue(snapshot());
  const getSystemPrompt = vi.fn().mockResolvedValue({ source: "live_effective", prompt: "runtime" });
  const api = { getSessionSteps, getSystemPrompt } as unknown as ApiClient;
  const props: Parameters<typeof useSessionInspection>[0] = { api, sessionId: "a", visible: true, activeTab: "steps", refreshKey: 0 };
  const hook = renderHook(useSessionInspection, { initialProps: props });
  let position = 0;
  /** The server pushed steps_changed: a new position for the current props. */
  const signal = async (patch: Partial<typeof props> = {}) => {
    Object.assign(props, patch, { stepsPosition: `p:${++position}` });
    hook.rerender({ ...props });
    await flush();
  };
  return { ...hook, props, signal, getSessionSteps, getSystemPrompt };
}
describe("useSessionInspection authority", () => {
  beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

  it("follows steps_changed, replacing 1000+ step snapshots rather than appending, and never polls", async () => {
    const h = setup(); await flush();
    expect(h.getSessionSteps).toHaveBeenCalledTimes(1);
    h.getSessionSteps.mockResolvedValue(snapshot("a", 2, "p", 1201));
    await h.signal();
    expect(h.result.current.steps?.steps).toHaveLength(1201);
    // Even while this page's request is live, time alone never reads steps.
    await tick(10_000);
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
  });

  it("is single flight: a signal during a read waits, and a superseded response is ignored", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>();
    h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await h.signal();
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    await h.signal();
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(snapshot("a", 99)));
    expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
    expect(h.result.current.steps?.revision).toBe(1);
    await tick(10_000); expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
  });

  it("rejects older/equal revisions, preserves identity, and replaces changed projections", async () => {
    const h = setup(); await flush(); const first = h.result.current.steps;
    h.getSessionSteps.mockResolvedValue(snapshot("a", 0)); await h.signal();
    expect(h.result.current.steps).toBe(first);
    h.getSessionSteps.mockResolvedValue(snapshot("a", 1, "p", 4)); await h.signal();
    expect(h.result.current.steps).toBe(first);
    h.getSessionSteps.mockResolvedValue(snapshot("a", 0, "new", 2)); await h.signal();
    expect(h.result.current.steps?.projectionId).toBe("new");
    expect(h.result.current.steps?.steps).toHaveLength(2);
  });

  it("isolates session changes and rejects wrong source without exposing another session", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>(); h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await h.signal();
    h.rerender({ ...h.props, sessionId: "b" });
    expect(h.result.current.steps).toBeNull();
    await act(async () => pending.resolve(snapshot("a", 9, "old")));
    expect(h.result.current.steps).toBeNull(); expect(h.result.current.stepsError).toContain("来源");
    h.getSessionSteps.mockResolvedValue(snapshot("b")); await h.signal({ sessionId: "b" });
    expect(h.result.current.steps?.sessionId).toBe("b");
    h.rerender({ ...h.props, sessionId: "a" }); expect(h.result.current.steps).toBeNull();
  });

  it("ignores signals when the tab, panel or session is gone, and pending responses after leaving", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>(); h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await h.signal(); await h.signal({ activeTab: "events" });
    await act(async () => pending.resolve(snapshot("a", 8)));
    expect(h.result.current.steps?.revision).toBe(1);
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    await h.signal({ visible: false }); await h.signal({ sessionId: null });
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    await h.signal({ activeTab: "steps", visible: true, sessionId: "a" }); expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
  });

  it("pauses in background, invalidates old HTTP and reads when visible again", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>(); h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await h.signal();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => pending.resolve(snapshot("a", 7)));
    await h.signal(); expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    expect(h.result.current.steps?.revision).toBe(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange"))); await flush();
    expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
  });

  it("reports loading and errors, retries a failed read at 500ms, and retains valid data", async () => {
    const h = setup(); expect(h.result.current.stepsLoading).toBe(true); await flush();
    const good = h.result.current.steps;
    h.getSessionSteps.mockRejectedValue(new Error("offline")); await h.signal();
    expect(h.result.current.steps).toBe(good); expect(h.result.current.stepsError).toBe("offline");
    expect(h.result.current.stepsLoading).toBe(false);
    await tick(499); expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    h.getSessionSteps.mockResolvedValue(snapshot("a", 2)); await tick(1);
    expect(h.result.current.stepsError).toBeNull(); expect(h.result.current.steps?.revision).toBe(2);
    // Recovered: back to signal-driven, no further timer reads.
    await tick(10_000); expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
  });

  it("reads real prompt provenance, empty string and unavailable as the steps signal moves; only while visible", async () => {
    const h = setup(); await flush(); expect(h.getSystemPrompt).not.toHaveBeenCalled();
    await h.signal({ activeTab: "systemPrompt" });
    expect(h.result.current.systemPrompt).toEqual({ source: "live_effective", prompt: "runtime" });
    h.getSystemPrompt.mockResolvedValue({ source: "creation_snapshot", prompt: "" }); await h.signal();
    expect(h.result.current.systemPrompt).toEqual({ source: "creation_snapshot", prompt: "" });
    h.getSystemPrompt.mockResolvedValue({ source: "unavailable", prompt: null }); await h.signal();
    expect(h.result.current.systemPrompt).toEqual({ source: "unavailable", prompt: null });
    await h.signal({ visible: false });
    expect(h.getSystemPrompt).toHaveBeenCalledTimes(3);
  });

  it("isolates old prompt responses on session/tab changes and retains prompt on errors", async () => {
    const h = setup(); await h.signal({ activeTab: "systemPrompt" });
    const pending = deferred<unknown>(); h.getSystemPrompt.mockReturnValueOnce(pending.promise);
    await h.signal(); h.rerender({ ...h.props, sessionId: "b" });
    expect(h.result.current.systemPrompt).toBeNull();
    h.getSystemPrompt.mockResolvedValue({ source: "creation_snapshot", prompt: "b" });
    await act(async () => pending.resolve({ source: "live_effective", prompt: "old a" }));
    expect(h.result.current.systemPrompt?.prompt).toBe("b");
    h.getSystemPrompt.mockRejectedValue(new Error("prompt failed")); await h.signal({ sessionId: "b" });
    expect(h.result.current.systemPrompt?.prompt).toBe("b");
    expect(h.result.current.systemPromptError).toBe("prompt failed");
    // Leaving the tab cancels the pending retry.
    await h.signal({ activeTab: "events" }); await tick(2000);
    expect(h.getSystemPrompt).toHaveBeenCalledTimes(4);
  });

  it("never polls the system prompt: a prompt change is itself a step, so steps_changed covers it", async () => {
    const h = setup(); await h.signal({ activeTab: "systemPrompt" });
    const settled = h.getSystemPrompt.mock.calls.length;
    await tick(10_000);
    expect(h.getSystemPrompt).toHaveBeenCalledTimes(settled);
    await h.signal();
    expect(h.getSystemPrompt).toHaveBeenCalledTimes(settled + 1);
  });
});
