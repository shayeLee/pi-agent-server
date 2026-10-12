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
  return { ...renderHook(useSessionInspection, { initialProps: props }), props, getSessionSteps, getSystemPrompt };
}
describe("useSessionInspection authority", () => {
  beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

  it("polls complete 1000+ delta snapshots without SSE, replacing rather than appending", async () => {
    const h = setup(); await flush();
    h.getSessionSteps.mockResolvedValue(snapshot("a", 2, "p", 1201));
    await tick(500);
    expect(h.result.current.steps?.steps).toHaveLength(1201);
    await tick(500);
    expect(h.result.current.steps?.steps).toHaveLength(1201);
    expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
  });

  it("is single flight and schedules from response completion, including refresh generations", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>();
    h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await tick(500); await tick(2000);
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    h.rerender({ ...h.props, refreshKey: 1 }); await flush();
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(snapshot("a", 99)));
    expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
    expect(h.result.current.steps?.revision).toBe(1);
    await tick(499); expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
    await tick(1); expect(h.getSessionSteps).toHaveBeenCalledTimes(4);
  });

  it("rejects older/equal revisions, preserves identity, and replaces changed projections", async () => {
    const h = setup(); await flush(); const first = h.result.current.steps;
    h.getSessionSteps.mockResolvedValue(snapshot("a", 0)); await tick(500);
    expect(h.result.current.steps).toBe(first);
    h.getSessionSteps.mockResolvedValue(snapshot("a", 1, "p", 4)); await tick(500);
    expect(h.result.current.steps).toBe(first);
    h.getSessionSteps.mockResolvedValue(snapshot("a", 0, "new", 2)); await tick(500);
    expect(h.result.current.steps?.projectionId).toBe("new");
    expect(h.result.current.steps?.steps).toHaveLength(2);
  });

  it("isolates session changes and rejects wrong source without exposing another session", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>(); h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await tick(500);
    h.rerender({ ...h.props, sessionId: "b" });
    expect(h.result.current.steps).toBeNull();
    await act(async () => pending.resolve(snapshot("a", 9, "old")));
    expect(h.result.current.steps).toBeNull(); expect(h.result.current.stepsError).toContain("来源");
    h.getSessionSteps.mockResolvedValue(snapshot("b")); await tick(500);
    expect(h.result.current.steps?.sessionId).toBe("b");
    h.rerender({ ...h.props, sessionId: "a" }); expect(h.result.current.steps).toBeNull();
  });

  it("stops on events/close/unknown session and ignores pending responses", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>(); h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await tick(500); h.rerender({ ...h.props, activeTab: "events" });
    await act(async () => pending.resolve(snapshot("a", 8)));
    expect(h.result.current.steps?.revision).toBe(1);
    await tick(2000); expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    h.rerender({ ...h.props, visible: false }); await tick(2000);
    h.rerender({ ...h.props, sessionId: null }); await tick(2000);
    expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    h.rerender(h.props); await flush(); expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
  });

  it("pauses in background, invalidates old HTTP and refreshes when visible", async () => {
    const h = setup(); await flush();
    const pending = deferred<SessionStepsSnapshot>(); h.getSessionSteps.mockReturnValueOnce(pending.promise);
    await tick(500);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => pending.resolve(snapshot("a", 7)));
    await tick(2500); expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    expect(h.result.current.steps?.revision).toBe(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange"))); await flush();
    expect(h.getSessionSteps).toHaveBeenCalledTimes(3);
  });

  it("reports initial/loading/errors, retries at 500ms, and retains valid data", async () => {
    const h = setup(); expect(h.result.current.stepsLoading).toBe(true); await flush();
    const good = h.result.current.steps;
    h.getSessionSteps.mockRejectedValue(new Error("offline")); await tick(500);
    expect(h.result.current.steps).toBe(good); expect(h.result.current.stepsError).toBe("offline");
    expect(h.result.current.stepsLoading).toBe(false);
    await tick(499); expect(h.getSessionSteps).toHaveBeenCalledTimes(2);
    h.getSessionSteps.mockResolvedValue(snapshot("a", 2)); await tick(1);
    expect(h.result.current.stepsError).toBeNull(); expect(h.result.current.steps?.revision).toBe(2);
  });

  it("reads real prompt provenance, empty string and unavailable; polls at 1s only while visible", async () => {
    const h = setup(); await flush(); expect(h.getSystemPrompt).not.toHaveBeenCalled();
    h.rerender({ ...h.props, activeTab: "systemPrompt" }); await flush();
    expect(h.result.current.systemPrompt).toEqual({ source: "live_effective", prompt: "runtime" });
    h.getSystemPrompt.mockResolvedValue({ source: "creation_snapshot", prompt: "" }); await tick(1000);
    expect(h.result.current.systemPrompt).toEqual({ source: "creation_snapshot", prompt: "" });
    h.getSystemPrompt.mockResolvedValue({ source: "unavailable", prompt: null }); await tick(1000);
    expect(h.result.current.systemPrompt).toEqual({ source: "unavailable", prompt: null });
    h.rerender({ ...h.props, activeTab: "systemPrompt", visible: false }); await tick(2000);
    expect(h.getSystemPrompt).toHaveBeenCalledTimes(3);
  });

  it("isolates old prompt responses on session/tab changes and retains prompt on errors", async () => {
    const h = setup(); h.rerender({ ...h.props, activeTab: "systemPrompt" }); await flush();
    const pending = deferred<unknown>(); h.getSystemPrompt.mockReturnValueOnce(pending.promise);
    await tick(1000); h.rerender({ ...h.props, sessionId: "b", activeTab: "systemPrompt" });
    expect(h.result.current.systemPrompt).toBeNull();
    h.getSystemPrompt.mockResolvedValue({ source: "creation_snapshot", prompt: "b" });
    await act(async () => pending.resolve({ source: "live_effective", prompt: "old a" }));
    expect(h.result.current.systemPrompt?.prompt).toBe("b");
    h.getSystemPrompt.mockRejectedValue(new Error("prompt failed")); await tick(1000);
    expect(h.result.current.systemPrompt?.prompt).toBe("b");
    expect(h.result.current.systemPromptError).toBe("prompt failed");
    h.rerender({ ...h.props, sessionId: "b", activeTab: "events" }); await tick(2000);
    expect(h.getSystemPrompt).toHaveBeenCalledTimes(4);
  });
});
