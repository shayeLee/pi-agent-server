import { StrictMode, type ReactNode } from "react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWebAppController } from "./hooks/useWebAppController.js";
import { readRecentSelection, recentSelectionKey, writeRecentSelection } from "./recent-selection.js";

vi.mock("pi-agent-server/client", async original => ({
  ...await original<typeof import("pi-agent-server/client")>(),
  createSseConnection: vi.fn(() => ({ close() {} })),
}));
const projects = [{ id: "p1", name: "Default", isDefault: true, cwd: "/fixture/1" }, { id: "p2", name: "Other", isDefault: false, cwd: "/fixture/2" }];
const sessions = [{ id: "s1", projectId: "p1", title: "One" }, { id: "s2", projectId: "p2", title: "Two" }];
let calls: string[];
let sessionStatus: number;
let projectRows: typeof projects;
let sessionRows: typeof sessions;
let release: (() => void) | null;
let hold: boolean;
beforeEach(() => {
  localStorage.clear(); calls = []; sessionStatus = 200; projectRows = projects; sessionRows = sessions; release = null; hold = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${input}`);
    const url = new URL(input, "http://fixture");
    let data: unknown = {};
    let status = 200;
    if (url.pathname === "/v1/projects") data = projectRows;
    if (url.pathname === "/v1/access") data = { canRead: true, canWrite: true };
    if (url.pathname === "/v1/models") data = { models: [], thinkingLevels: [], defaultModel: null, defaultThinkingLevel: "off" };
    if (url.pathname === "/v1/sessions") {
      if (!url.search && hold) await new Promise<void>(resolve => { release = resolve; });
      status = sessionStatus;
      data = sessionRows.filter(row => !url.searchParams.has("projectId") || row.projectId === url.searchParams.get("projectId"));
    }
    if (url.pathname.endsWith("/export")) data = { messages: [{ role: "user", text: "Synthetic history" }], lastEventId: 0 };
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function ready(result: { current: ReturnType<typeof useWebAppController> }) {
  await waitFor(() => expect(result.current.sessions).not.toBeNull());
}
const strictWrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
describe("recent authorized navigation", () => {
  it("coalesces StrictMode startup while recent metadata is delayed", async () => {
    writeRecentSelection("p2", "s2"); hold = true;
    const { result } = renderHook(useWebAppController, { wrapper: strictWrapper });
    await waitFor(() => expect(release).not.toBeNull());
    expect(calls.filter(call => call === "GET /v1/projects")).toHaveLength(1);
    expect(calls.filter(call => call.startsWith("GET /v1/sessions?"))).toEqual([]);
    await act(async () => release!());
    await waitFor(() => expect(result.current.chatState.timeline).toHaveLength(1));
    expect(result.current.activeProjectId).toBe("p2");
    expect(result.current.activeSessionId).toBe("s2");
    expect(calls.filter(call => call.endsWith("/export"))).toEqual(["GET /v1/sessions/s2/export"]);
    expect(calls).not.toContain("GET /v1/sessions?projectId=p1");
  });
  it("StrictMode delayed restore cannot replace a newer project draft", async () => {
    writeRecentSelection("p2", "s2"); hold = true;
    const { result } = renderHook(useWebAppController, { wrapper: strictWrapper });
    await waitFor(() => expect(release).not.toBeNull());
    act(() => result.current.selectProject("p1"));
    await ready(result);
    act(() => { result.current.createSession(); result.current.setUnsentText("protected draft"); });
    await act(async () => release!());
    expect(result.current.activeProjectId).toBe("p1");
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.draftSource.getSnapshot(result.current.draftScope).text).toBe("protected draft");
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p1", sessionId: null });
    expect(calls.some(call => call.endsWith("/export"))).toBe(false);
  });
  it("input-only edits invalidate delayed startup restore without requiring navigation", async () => {
    writeRecentSelection("p2", "s2"); hold = true;
    const { result } = renderHook(useWebAppController, { wrapper: strictWrapper });
    await waitFor(() => expect(release).not.toBeNull());
    act(() => result.current.setUnsentText("typed before initialization"));
    const scope = result.current.draftScope;
    await act(async () => release!());
    await ready(result);
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.activeProjectId).toBe("p1");
    expect(result.current.draftSource.getSnapshot(scope).text).toBe("typed before initialization");
    expect(calls.some(call => call.endsWith("/export"))).toBe(false);
  });
  it("reloads the same nondefault IDs with one export and no writes", async () => {
    writeRecentSelection("p2", "s2");
    for (let i = 0; i < 2; i++) {
      calls = [];
      const { result, unmount } = renderHook(useWebAppController);
      await waitFor(() => expect(result.current.chatState.timeline).toHaveLength(1));
      expect(result.current.activeProjectId).toBe("p2"); expect(result.current.activeSessionId).toBe("s2");
      expect(calls.filter(call => call.endsWith("/export"))).toEqual(["GET /v1/sessions/s2/export"]);
      expect(calls.filter(call => !call.startsWith("GET"))).toEqual([]);
      unmount();
    }
  });
  it("resolves a moved/injected session association using server metadata", async () => {
    writeRecentSelection("p1", "s2");
    const { result } = renderHook(useWebAppController);
    await waitFor(() => expect(result.current.activeSessionId).toBe("s2"));
    expect(result.current.activeProjectId).toBe("p2");
    expect(readRecentSelection()?.projectId).toBe("p2");
    expect(calls).not.toContain("GET /v1/sessions/s1/export");
  });
  it.each([403, 404, 200])("clears unavailable session (%s) without opening another history", async status => {
    writeRecentSelection("p2", "missing"); sessionStatus = status;
    const { result } = renderHook(useWebAppController);
    await waitFor(() => expect(result.current.activeProjectId).toBe("p1"));
    expect(result.current.activeSessionId).toBeNull(); expect(readRecentSelection()).toBeNull();
    expect(calls.some(call => call.endsWith("/export"))).toBe(false);
  });
  it("preserves choice after transient failure", async () => {
    writeRecentSelection("p2", "s2"); sessionStatus = 503;
    const { result } = renderHook(useWebAppController);
    await waitFor(() => expect(result.current.activeProjectId).toBe("p1"));
    expect(readRecentSelection()?.sessionId).toBe("s2"); expect(result.current.activeSessionId).toBeNull();
  });
  it("remembers explicit new session as project blank, not unsent text", async () => {
    writeRecentSelection("p2", "s2");
    const first = renderHook(useWebAppController); await ready(first.result);
    act(() => { first.result.current.createSession(); first.result.current.setUnsentText("do not persist"); });
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p2", sessionId: null });
    first.unmount();
    const second = renderHook(useWebAppController); await ready(second.result);
    expect(second.result.current.activeProjectId).toBe("p2"); expect(second.result.current.activeSessionId).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain("do not persist");
  });
  it("does not overwrite user choice while startup metadata is pending", async () => {
    writeRecentSelection("p2", "s2"); hold = true;
    const { result } = renderHook(useWebAppController);
    await waitFor(() => expect(release).not.toBeNull());
    act(() => { result.current.selectProject("p1"); result.current.setUnsentText("new draft"); release!(); });
    await ready(result);
    expect(result.current.activeProjectId).toBe("p1"); expect(result.current.activeSessionId).toBeNull();
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p1", sessionId: null });
  });
  it("pending creation cannot select over an explicit newer blank draft", async () => {
    writeRecentSelection("p2", null);
    const originalFetch = globalThis.fetch;
    let finishCreation: (() => void) | undefined;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input === "/v1/sessions" && init?.method === "POST") {
        await new Promise<void>(resolve => { finishCreation = resolve; });
        return new Response(JSON.stringify({ id: "created", projectId: "p2", title: "Created" }), { status: 201 });
      }
      return originalFetch(input, init);
    });
    const { result } = renderHook(useWebAppController); await ready(result);
    act(() => result.current.setUnsentText("sent snapshot"));
    let submission!: Promise<unknown>;
    act(() => { submission = result.current.sendMessage("sent snapshot"); });
    await waitFor(() => expect(finishCreation).toBeDefined());
    act(() => { result.current.createSession(); result.current.setUnsentText("new generation draft"); });
    await act(async () => { finishCreation!(); await submission; });
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.draftSource.getSnapshot(result.current.draftScope).text).toBe("new generation draft");
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p2", sessionId: null });
  });
  it("safely falls back for an omitted empty project", async () => {
    writeRecentSelection("omitted", null);
    const { result } = renderHook(useWebAppController); await ready(result);
    expect(result.current.activeProjectId).toBe("p1"); expect(readRecentSelection()).toBeNull();
  });
  it.each(["{", JSON.stringify({ version: 2, projectId: "p2", sessionId: "s2" }), "x".repeat(1025)])("cleans malformed records", value => {
    localStorage.setItem(recentSelectionKey(), value);
    expect(readRecentSelection()).toBeNull(); expect(localStorage.getItem(recentSelectionKey())).toBeNull();
  });
  it("preserves choice on a network timeout", async () => {
    writeRecentSelection("p2", "s2");
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input === "/v1/sessions") throw new TypeError("timeout");
      return fetch(input, init);
    });
    const { result } = renderHook(useWebAppController); await ready(result);
    expect(result.current.activeSessionId).toBeNull(); expect(readRecentSelection()?.sessionId).toBe("s2");
  });
  it("clears an explicitly deleted selection", async () => {
    writeRecentSelection("p2", "s2");
    const { result } = renderHook(useWebAppController);
    await waitFor(() => expect(result.current.activeSessionId).toBe("s2"));
    sessionRows = sessions.filter(row => row.id !== "s2");
    await act(async () => result.current.deleteSession("s2"));
    expect(readRecentSelection()).toBeNull(); expect(result.current.activeSessionId).toBeNull();
  });
  it("filtered zero projects keeps a default creation target without restoring history", async () => {
    projectRows = []; sessionRows = [];
    writeRecentSelection("p2", "s2");
    const { result } = renderHook(useWebAppController); await ready(result);
    expect(result.current.projects).toEqual([]); expect(result.current.activeProjectId).not.toBeNull();
    expect(result.current.activeSessionId).toBeNull(); expect(readRecentSelection()).toBeNull();
    expect(calls.some(call => call.endsWith("/export"))).toBe(false);
  });
  it("works when localStorage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    const { result } = renderHook(useWebAppController); await ready(result);
    act(() => result.current.selectProject("p2"));
    await waitFor(() => expect(result.current.activeProjectId).toBe("p2"));
  });
});
