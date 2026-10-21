import { StrictMode, type ReactNode } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID, ApiClient, ApiError, createSseConnection, type SessionRecord } from "pi-agent-server/client";
import { useWebAppController } from "./hooks/useWebAppController.js";
import App from "./App.js";
import { readRoute, writeRoute } from "./routing.js";
import { readRecentSelection, writeRecentSelection } from "./recent-selection.js";
vi.mock("pi-agent-server/client", async original => ({
  ...await original<typeof import("pi-agent-server/client")>(),
  createSseConnection: vi.fn(() => ({ close() {} })),
}));
const projects = [{ id: "p1", name: "One", cwd: "/fixture/1", isDefault: true }, { id: "p2", name: "Two", cwd: "/fixture/2", isDefault: false }];
const records = ["s1", "s2"].map((id, index): SessionRecord => ({ id, projectId: `p${index + 1}`, ownerKey: "fixture", title: id, createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null }));
const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  localStorage.clear(); window.history.replaceState(null, "", "/");
  vi.spyOn(ApiClient.prototype, "listProjects").mockResolvedValue(projects);
  vi.spyOn(ApiClient.prototype, "listSessions").mockResolvedValue(records);
  vi.spyOn(ApiClient.prototype, "listSessionsByProject").mockImplementation(async id => records.filter(row => row.projectId === id));
  vi.spyOn(ApiClient.prototype, "getAccess").mockResolvedValue({ canRead: true, canWrite: true });
  vi.spyOn(ApiClient.prototype, "listModels").mockResolvedValue({ models: [], thinkingLevels: [], defaultModel: null, defaultThinkingLevel: "off", modelThinkingLevels: {} });
  vi.spyOn(ApiClient.prototype, "exportSession").mockResolvedValue({ messages: [], timeline: [], lastEventId: 0 });
  vi.spyOn(ApiClient.prototype, "deleteSession").mockResolvedValue(undefined);
  vi.spyOn(ApiClient.prototype, "createSession").mockResolvedValue({ ...records[0], id: "created" });
  vi.spyOn(ApiClient.prototype, "sendMessage").mockResolvedValue(undefined);
  vi.mocked(createSseConnection).mockClear();
});
afterEach(() => vi.restoreAllMocks());
const path = () => window.location.pathname;
const start = (url: string) => { window.history.replaceState(null, "", url); return renderHook(useWebAppController, { wrapper }); };
async function selected(result: { current: ReturnType<typeof useWebAppController> }, id: string | null) {
  await waitFor(() => { expect(result.current.sessions).not.toBeNull(); expect(result.current.activeSessionId).toBe(id); });
}
function pop(url: string) { window.history.replaceState(null, "", url); window.dispatchEvent(new PopStateEvent("popstate")); }
describe("History navigation", () => {
  it("URL beats recent and StrictMode exports only the authorized deep link once", async () => {
    writeRecentSelection("p1", "s1");
    const { result } = start("/p/p2/s/s2"); await selected(result, "s2");
    expect(result.current.activeProjectId).toBe("p2");
    expect(ApiClient.prototype.listProjects).toHaveBeenCalledTimes(1);
    expect(ApiClient.prototype.exportSession).toHaveBeenCalledExactlyOnceWith("s2");
  });
  it("corrects ownership with replace and loads the real project before selecting", async () => {
    const replace = vi.spyOn(window.history, "replaceState"); const push = vi.spyOn(window.history, "pushState");
    const list = deferred<SessionRecord[]>();
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(list.promise);
    const { result } = start("/p/p1/s/s2");
    await waitFor(() => expect(ApiClient.prototype.listSessionsByProject).toHaveBeenCalledWith("p2"));
    expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
    await act(async () => list.resolve([records[1]])); await selected(result, "s2");
    expect(path()).toBe("/p/p2/s/s2"); expect(push).not.toHaveBeenCalled(); expect(replace).toHaveBeenLastCalledWith(null, "", "/p/p2/s/s2");
  });
  it("pushes user navigation once per URL, with project switches exiting the session", async () => {
    const { result } = start("/p/p1"); await selected(result, null);
    const push = vi.spyOn(window.history, "pushState");
    act(() => { result.current.selectSession("s1"); result.current.selectSession("s1"); });
    expect(push).toHaveBeenCalledTimes(1);
    act(() => result.current.selectProject("p2")); await selected(result, null);
    expect(path()).toBe("/p/p2"); expect(result.current.activeProjectId).toBe("p2");
  });
  it("back and forward restore state without push and keep the controller draft store", async () => {
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    const source = result.current.draftSource;
    act(() => result.current.selectProject("p2")); await selected(result, null);
    const push = vi.spyOn(window.history, "pushState");
    await act(async () => window.history.back()); await selected(result, "s1");
    await act(async () => window.history.forward());
    await waitFor(() => expect(result.current.activeProjectId).toBe("p2")); await selected(result, null);
    expect(push).not.toHaveBeenCalled(); expect(result.current.draftSource).toBe(source);
  });
  it("late A metadata cannot replace a newer B navigation", async () => {
    const metadata = deferred<SessionRecord[]>(); vi.mocked(ApiClient.prototype.listSessions).mockReturnValueOnce(metadata.promise);
    const { result } = start("/p/p1/s/s1");
    await waitFor(() => expect(ApiClient.prototype.listSessions).toHaveBeenCalledTimes(1));
    act(() => pop("/p/p2/s/s2")); await selected(result, "s2");
    await act(async () => metadata.resolve(records));
    expect(path()).toBe("/p/p2/s/s2"); expect(result.current.activeSessionId).toBe("s2");
    expect(ApiClient.prototype.exportSession).toHaveBeenCalledExactlyOnceWith("s2");
  });
  it("late A project list cannot select over B", async () => {
    const list = deferred<SessionRecord[]>(); vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(list.promise);
    const { result } = start("/p/p1/s/s1");
    await waitFor(() => expect(ApiClient.prototype.listSessionsByProject).toHaveBeenCalledWith("p1"));
    act(() => pop("/p/p2/s/s2")); await selected(result, "s2");
    await act(async () => list.resolve([records[0]]));
    expect(result.current.activeSessionId).toBe("s2"); expect(path()).toBe("/p/p2/s/s2");
  });
  it.each([403, 404, 200])("missing/denied target (%s) never opens recent or exports a probe", async status => {
    writeRecentSelection("p1", "s1");
    if (status !== 200) vi.mocked(ApiClient.prototype.listSessions).mockRejectedValueOnce(new ApiError(status, "unavailable"));
    const { result } = start("/p/p2/s/missing"); await selected(result, null);
    expect(path()).toBe("/p/p2"); expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
  });
  it("5xx keeps the deep-link URL for retry, without opening recent", async () => {
    writeRecentSelection("p1", "s1"); vi.mocked(ApiClient.prototype.listSessions).mockRejectedValueOnce(new ApiError(503, "temporary"));
    const { result } = start("/p/p2/s/s2"); await selected(result, null);
    expect(path()).toBe("/p/p2/s/s2"); expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
  });
  it("unauthorized real project is never exported even if an injected metadata row mentions it", async () => {
    vi.mocked(ApiClient.prototype.listSessions).mockResolvedValueOnce([{ ...records[1], projectId: "hidden" }]);
    const { result } = start("/p/p2/s/s2"); await selected(result, null);
    expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled(); expect(path()).toBe("/p/p2");
  });
  it("successful current deletion replaces the project start; noncurrent and late deletion do not navigate", async () => {
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    await act(async () => result.current.deleteSession("s2")); expect(path()).toBe("/p/p1/s/s1");
    const deletion = deferred<void>(); vi.mocked(ApiClient.prototype.deleteSession).mockReturnValueOnce(deletion.promise);
    let pending!: Promise<void>; act(() => { pending = result.current.deleteSession("s1"); result.current.selectProject("p2"); });
    await act(async () => { deletion.resolve(); await pending; }); expect(path()).toBe("/p/p2");
    act(() => pop("/p/p1/s/s1")); await selected(result, "s1");
    const push = vi.spyOn(window.history, "pushState");
    await act(async () => result.current.deleteSession("s1"));
    expect(path()).toBe("/p/p1"); expect(result.current.activeSessionId).toBeNull(); expect(push).not.toHaveBeenCalled();
  });
  it.each([false, true])("first creation replaces only if navigation is unchanged (leave: %s)", async leave => {
    const { result } = start("/p/p1"); await selected(result, null);
    act(() => { result.current.createSession(); result.current.setUnsentText("first"); });
    expect(ApiClient.prototype.createSession).not.toHaveBeenCalled();
    const creation = deferred<SessionRecord>(); vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    let pending!: Promise<boolean>; act(() => { pending = result.current.sendMessage("first"); });
    await waitFor(() => expect(ApiClient.prototype.createSession).toHaveBeenCalledTimes(1));
    if (leave) act(() => result.current.selectProject("p2"));
    const push = vi.spyOn(window.history, "pushState");
    await act(async () => { creation.resolve({ ...records[0], id: "created" }); await pending; });
    expect(path()).toBe(leave ? "/p/p2" : "/p/p1/s/created"); expect(push).not.toHaveBeenCalled();
  });
  it("refreshing a project start restores no draft or recent session", async () => {
    const first = start("/p/p2"); await selected(first.result, null);
    act(() => first.result.current.setUnsentText("local draft")); first.unmount();
    writeRecentSelection("p1", "s1");
    const second = renderHook(useWebAppController, { wrapper }); await selected(second.result, null);
    expect(second.result.current.activeProjectId).toBe("p2");
    expect(second.result.current.draftSource.getSnapshot(second.result.current.draftScope).text).toBe("");
    expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
  });
  it("empty filtered project list never invents a target", async () => {
    vi.mocked(ApiClient.prototype.listProjects).mockResolvedValue([]);
    const { result } = start("/p/p2/s/s2"); await selected(result, null);
    expect(result.current.activeProjectId).toBeNull(); expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
    expect(ApiClient.prototype.listSessionsByProject).not.toHaveBeenCalled();
    expect(await result.current.sendMessage("first")).toBe(false);
  });
  it.each(["/p/%ZZ/s/s1", "/unknown", "/p/p1/s/%00"])("invalid URL %s normalizes without recent restoration", async url => {
    writeRecentSelection("p2", "s2"); const { result } = start(url); await selected(result, null);
    expect(path()).toBe("/p/p1"); expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
  });
  it("root keeps the filtered default first-send target without inventing project metadata", async () => {
    vi.mocked(ApiClient.prototype.listProjects).mockResolvedValue([]);
    vi.mocked(ApiClient.prototype.createSession).mockResolvedValue({ ...records[0], projectId: DEFAULT_PROJECT_ID, id: "created" });
    const first = start("/"); await selected(first.result, null);
    expect(first.result.current.activeProjectId).toBe(DEFAULT_PROJECT_ID);
    expect(first.result.current.projects).toEqual([]);
    expect(ApiClient.prototype.listSessionsByProject).toHaveBeenCalledWith(DEFAULT_PROJECT_ID);
    expect(path()).toBe("/");
    first.unmount();
    const second = renderHook(useWebAppController, { wrapper }); await selected(second.result, null);
    expect(second.result.current.activeProjectId).toBe(DEFAULT_PROJECT_ID);
    await act(async () => { expect(await second.result.current.sendMessage("first")).toBe(true); });
    expect(ApiClient.prototype.createSession).toHaveBeenCalledWith(undefined, DEFAULT_PROJECT_ID, expect.any(String));
    expect(path()).toBe(`/p/${DEFAULT_PROJECT_ID}/s/created`);
    expect(second.result.current.projects).toEqual([]);
  });
  it("root editing before empty project metadata arrives does not disable the default target", async () => {
    const metadata = deferred<typeof projects>();
    vi.mocked(ApiClient.prototype.listProjects).mockReturnValueOnce(metadata.promise);
    const { result } = start("/");
    act(() => result.current.setUnsentText("early draft"));
    await act(async () => metadata.resolve([])); await selected(result, null);
    expect(result.current.activeProjectId).toBe(DEFAULT_PROJECT_ID);
    expect(path()).toBe("/");
  });
  it("explicit unknown project with an empty list cannot use the root-only default target", async () => {
    vi.mocked(ApiClient.prototype.listProjects).mockResolvedValue([]);
    const { result } = start("/p/unknown"); await selected(result, null);
    expect(result.current.activeProjectId).toBeNull(); expect(result.current.projects).toEqual([]);
    expect(ApiClient.prototype.listSessionsByProject).not.toHaveBeenCalled();
    expect(await result.current.sendMessage("first")).toBe(false);
    expect(ApiClient.prototype.createSession).not.toHaveBeenCalled();
  });
  it("missing authorized session metadata reports an unavailable target without exporting", async () => {
    const { result } = start("/p/p1/s/missing"); await selected(result, null);
    expect(result.current.loadError).toBe("会话不存在或无权限访问");
    expect(path()).toBe("/p/p1"); expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
  });
  it.each(["retryProjects", "retryNavigation"] as const)("%s actually retries transient URL session resolution", async retry => {
    vi.mocked(ApiClient.prototype.listSessions).mockRejectedValueOnce(new ApiError(503, "temporary"));
    const { result } = start("/p/p2/s/s2"); await selected(result, null);
    expect(result.current.loadError).toBe("temporary"); expect(path()).toBe("/p/p2/s/s2");
    await act(async () => result.current[retry]()); await selected(result, "s2");
    expect(result.current.loadError).toBeNull();
    expect(ApiClient.prototype.exportSession).toHaveBeenCalledExactlyOnceWith("s2");
  });
  it("newly created projects still load their session list after the routing effect replacement", async () => {
    vi.spyOn(ApiClient.prototype, "createProject").mockResolvedValue({ id: "new-project", name: "New", cwd: "/fixture/new", isDefault: false });
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    await act(async () => result.current.createProject("New", "/fixture/new")); await selected(result, null);
    expect(ApiClient.prototype.listSessionsByProject).toHaveBeenCalledWith("new-project");
    expect(result.current.activeProjectId).toBe("new-project"); expect(result.current.sessions).toEqual([]);
    expect(path()).toBe("/p/new-project");
  });
  it("renders a usable retry action for transient deep-link failures", async () => {
    window.history.replaceState(null, "", "/p/p2/s/s2");
    vi.mocked(ApiClient.prototype.listSessions).mockRejectedValueOnce(new ApiError(503, "temporary"));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("retry-navigation")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("retry-navigation"));
    await waitFor(() => expect(ApiClient.prototype.exportSession).toHaveBeenCalledExactlyOnceWith("s2"));
    expect(screen.queryByTestId("retry-navigation")).not.toBeInTheDocument();
  });
  it.each(["text", "attachment"])("root recent restore is cancelled by %s during the project session list", async edit => {
    writeRecentSelection("p2", "s2");
    const list = deferred<SessionRecord[]>();
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(list.promise);
    const { result } = start("/");
    await waitFor(() => expect(result.current.activeProjectId).toBe("p2"));
    if (edit === "text") act(() => result.current.setUnsentText("visible draft"));
    else await act(async () => result.current.addUnsentFile(new File(["image"], "draft.png", { type: "image/png" })));
    await act(async () => list.resolve([records[1]]));
    await selected(result, null);
    expect(result.current.draftScope).toBe("new:p2");
    const visible = result.current.draftSource.getSnapshot(result.current.draftScope);
    if (edit === "text") expect(visible.text).toBe("visible draft");
    else expect(visible.attachments).toEqual([expect.objectContaining({ name: "draft.png", status: "ready" })]);
    expect(path()).toBe("/p/p2");
    expect(ApiClient.prototype.exportSession).not.toHaveBeenCalled();
  });
  it("keeps Composer gated until root recent metadata establishes the visible draft owner", async () => {
    writeRecentSelection("p2", "s2");
    const metadata = deferred<SessionRecord[]>();
    const list = deferred<SessionRecord[]>();
    vi.mocked(ApiClient.prototype.listSessions).mockReturnValueOnce(metadata.promise);
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(list.promise);
    render(<App />);
    await waitFor(() => expect(ApiClient.prototype.listSessions).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("composer-input")).not.toBeInTheDocument();
    await act(async () => metadata.resolve([]));
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "current owner draft" } });
    await act(async () => list.resolve([records[0]]));
    expect(path()).toBe("/p/p1");
    expect(screen.getByTestId("composer-input")).toHaveValue("current owner draft");
  });
  it.each([403, 404])("export %s replaces an invalid deep link with a project start and notice", async status => {
    vi.mocked(ApiClient.prototype.exportSession).mockRejectedValueOnce(new ApiError(status, "unavailable"));
    const push = vi.spyOn(window.history, "pushState");
    const { result } = start("/p/p2/s/s2");
    await waitFor(() => expect(ApiClient.prototype.exportSession).toHaveBeenCalledWith("s2"));
    await selected(result, null);
    expect(path()).toBe("/p/p2");
    expect(result.current.loadError).toBe("会话不存在或无权限访问");
    expect(readRecentSelection()).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(createSseConnection).not.toHaveBeenCalled();
  });
  it("late invalid export cannot clear a newer session or its URL and recent selection", async () => {
    const exported = deferred<Awaited<ReturnType<ApiClient["exportSession"]>>>();
    vi.mocked(ApiClient.prototype.exportSession).mockReturnValueOnce(exported.promise);
    const { result } = start("/p/p2/s/s2"); await selected(result, "s2");
    act(() => pop("/p/p1/s/s1")); await selected(result, "s1");
    await act(async () => exported.reject(new ApiError(404, "old session")));
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.loadError).toBeNull();
    expect(path()).toBe("/p/p1/s/s1");
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p1", sessionId: "s1" });
  });
  it("guards invalid export by navigation identity before the old effect cleanup runs", async () => {
    const exported = deferred<Awaited<ReturnType<ApiClient["exportSession"]>>>();
    const next = { ...records[1], id: "s3" };
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockResolvedValue([records[1], next]);
    vi.mocked(ApiClient.prototype.exportSession).mockReturnValueOnce(exported.promise);
    const { result } = start("/p/p2/s/s2"); await selected(result, "s2");
    await act(async () => {
      result.current.selectSession("s3");
      exported.reject(new ApiError(403, "old owner"));
      // The old export settles in the same batch, before the selection render.
      await exported.promise.catch(() => {});
    });
    await selected(result, "s3");
    expect(path()).toBe("/p/p2/s/s3");
    expect(result.current.loadError).toBeNull();
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p2", sessionId: "s3" });
  });
  it("shared startup failure after popstate exposes retry for the latest address", async () => {
    const metadata = deferred<typeof projects>();
    vi.mocked(ApiClient.prototype.listProjects).mockReturnValueOnce(metadata.promise);
    window.history.replaceState(null, "", "/p/p1/s/s1");
    render(<App />);
    await waitFor(() => expect(ApiClient.prototype.listProjects).toHaveBeenCalledOnce());
    act(() => pop("/p/p2/s/s2"));
    await act(async () => metadata.reject(new ApiError(503, "startup unavailable")));
    expect(await screen.findByTestId("projects-error")).toHaveTextContent("startup unavailable");
    expect(screen.queryByTestId("sessions-loading")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("retry-projects"));
    await waitFor(() => expect(ApiClient.prototype.exportSession).toHaveBeenCalledExactlyOnceWith("s2"));
    expect(path()).toBe("/p/p2/s/s2");
    expect(screen.queryByTestId("projects-error")).not.toBeInTheDocument();
  });
  it("does not offer address retry for a permanently unavailable normalized target", async () => {
    window.history.replaceState(null, "", "/p/p2/s/missing");
    render(<App />);
    await waitFor(() => expect(path()).toBe("/p/p2"));
    expect(screen.getByRole("alert")).toHaveTextContent("会话不存在或无权限访问");
    expect(screen.queryByTestId("retry-navigation")).not.toBeInTheDocument();
  });
  it.each([403, 404])("pending export reselect gets a replacement owner (%s)", async status => {
    const old = deferred<Awaited<ReturnType<ApiClient["exportSession"]>>>();
    const replacement = deferred<Awaited<ReturnType<ApiClient["exportSession"]>>>();
    vi.mocked(ApiClient.prototype.exportSession).mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    act(() => result.current.selectSession("s1"));
    await waitFor(() => expect(ApiClient.prototype.exportSession).toHaveBeenCalledTimes(2));
    await act(async () => old.reject(new ApiError(status, "old")));
    expect(result.current.activeSessionId).toBe("s1");
    await act(async () => replacement.reject(new ApiError(status, "current")));
    await selected(result, null);
    expect(path()).toBe("/p/p1"); expect(readRecentSelection()).toBeNull();
  });
  it("batched A → B → A invalidates the old export before cleanup and starts a new owner", async () => {
    const old = deferred<Awaited<ReturnType<ApiClient["exportSession"]>>>();
    const next = { ...records[0], id: "s3" };
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockResolvedValue([records[0], next]);
    vi.mocked(ApiClient.prototype.exportSession).mockReturnValueOnce(old.promise);
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    await act(async () => {
      result.current.selectSession("s3"); result.current.selectSession("s1");
      old.reject(new ApiError(404, "old")); await old.promise.catch(() => {});
    });
    await waitFor(() => expect(createSseConnection).toHaveBeenCalledOnce());
    expect(ApiClient.prototype.exportSession).toHaveBeenCalledTimes(2);
    expect(result.current.activeSessionId).toBe("s1"); expect(result.current.loadError).toBeNull();
    expect(path()).toBe("/p/p1/s/s1");
  });
  it.each([403, 404, 503].flatMap(status => ["explicit", "root", "direct"].map(entry => ({ status, entry }))))(
    "project session list $status at $entry ends loading without deleting metadata", async ({ status, entry }) => {
      const failure = deferred<SessionRecord[]>();
      let hook: ReturnType<typeof start>;
      if (entry === "direct") {
        hook = start("/p/p1/s/s1"); await selected(hook.result, "s1");
        vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(failure.promise);
        act(() => hook.result.current.selectProject("p2"));
      } else {
        writeRecentSelection("p2", "s2");
        vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(failure.promise);
        hook = start(entry === "root" ? "/" : "/p/p2/s/s2");
      }
      await waitFor(() => expect(hook.result.current.activeProjectId).toBe("p2"));
      await act(async () => failure.reject(new ApiError(status, "list failed")));
      await selected(hook.result, null);
      expect(hook.result.current.projects).toEqual(projects);
      expect(hook.result.current.loadError).toBe("list failed");
      expect(hook.result.current.navigationRetryAvailable).toBe(status === 503);
      if (status === 503) {
        expect(path()).toBe(entry === "root" ? "/" : entry === "direct" ? "/p/p2" : "/p/p2/s/s2");
        await act(async () => hook.result.current.retryNavigation());
        await selected(hook.result, entry === "direct" ? null : "s2");
      } else {
        expect(path()).toBe("/p/p2"); expect(readRecentSelection()).toBeNull();
      }
    },
  );
  it("explicit missing session clears only matching recent", async () => {
    writeRecentSelection("p2", "s2");
    vi.mocked(ApiClient.prototype.listSessions).mockResolvedValueOnce([records[0]]);
    const { result } = start("/p/p2/s/s2"); await selected(result, null);
    expect(readRecentSelection()).toBeNull();
  });
  it("fallback list failure does not invalidate an unverified original recent target", async () => {
    writeRecentSelection("p2", "s2");
    vi.mocked(ApiClient.prototype.listSessions).mockRejectedValueOnce(new ApiError(503, "metadata"));
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockRejectedValueOnce(new ApiError(404, "fallback"));
    const { result } = start("/"); await selected(result, null);
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p2", sessionId: "s2" });
    expect(path()).toBe("/"); expect(result.current.navigationRetryAvailable).toBe(true);
  });
  it("pending project creation after navigation updates metadata without taking selection", async () => {
    const creation = deferred<typeof projects[number]>();
    vi.spyOn(ApiClient.prototype, "createProject").mockReturnValueOnce(creation.promise);
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    let pending!: Promise<void>;
    act(() => { pending = result.current.createProject("New", "/new"); result.current.selectProject("p2"); });
    await selected(result, null);
    await act(async () => { creation.resolve({ id: "new", name: "New", cwd: "/new", isDefault: false }); await pending; });
    expect(result.current.activeProjectId).toBe("p2"); expect(path()).toBe("/p/p2");
    expect(result.current.projects).toContainEqual(expect.objectContaining({ id: "new" }));
    expect(ApiClient.prototype.listSessionsByProject).not.toHaveBeenCalledWith("new");
  });
  it("failed pending project creation preserves the current stream owner", async () => {
    const creation = deferred<typeof projects[number]>();
    vi.spyOn(ApiClient.prototype, "createProject").mockReturnValueOnce(creation.promise);
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    await waitFor(() => expect(createSseConnection).toHaveBeenCalledOnce());
    const connection = vi.mocked(createSseConnection).mock.results[0].value;
    const close = vi.spyOn(connection, "close");
    let caught!: Promise<unknown>;
    act(() => { caught = result.current.createProject("New", "/new").catch(error => error); });
    expect(close).not.toHaveBeenCalled();
    await act(async () => { creation.reject(new ApiError(503, "creation")); expect(await caught).toBeInstanceOf(ApiError); });
    expect(result.current.activeSessionId).toBe("s1"); expect(result.current.loadError).toBeNull();
    expect(path()).toBe("/p/p1/s/s1");
    expect(ApiClient.prototype.exportSession).toHaveBeenCalledExactlyOnceWith("s1");
    expect(createSseConnection).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
  it.each([403, 404, 503])("failed creation keeps a pending project list's %s error and retry lifecycle", async status => {
    const creation = deferred<typeof projects[number]>();
    const list = deferred<SessionRecord[]>();
    vi.spyOn(ApiClient.prototype, "createProject").mockReturnValueOnce(creation.promise);
    const { result } = start("/p/p1/s/s1"); await selected(result, "s1");
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(list.promise);
    act(() => result.current.selectProject("p2"));
    await waitFor(() => expect(ApiClient.prototype.listSessionsByProject).toHaveBeenCalledWith("p2"));
    expect(result.current.sessions).toBeNull();
    let caught!: Promise<unknown>;
    act(() => { caught = result.current.createProject("New", "/new").catch(error => error); });
    await act(async () => { creation.reject(new ApiError(503, "creation")); expect(await caught).toBeInstanceOf(ApiError); });
    expect(result.current.sessions).toBeNull();
    expect(result.current.activeProjectId).toBe("p2"); expect(path()).toBe("/p/p2");
    await act(async () => list.reject(new ApiError(status, "list failed")));
    await selected(result, null);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.loadError).toBe("list failed");
    expect(result.current.navigationRetryAvailable).toBe(status === 503);
    expect(result.current.projects).toEqual(projects);
    expect(result.current.activeProjectId).toBe("p2"); expect(path()).toBe("/p/p2");
    if (status === 503) {
      await act(async () => result.current.retryNavigation()); await selected(result, null);
      expect(result.current.sessions).toEqual([records[1]]);
      expect(result.current.loadError).toBeNull();
      expect(result.current.navigationRetryAvailable).toBe(false);
    }
  });
  it.each([403, 404, 503])("old project list failure %s cannot change the new error or retry", async status => {
    const old = deferred<SessionRecord[]>(); const current = deferred<SessionRecord[]>();
    vi.mocked(ApiClient.prototype.listSessionsByProject).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { result } = start("/p/p1/s/s1");
    await waitFor(() => expect(ApiClient.prototype.listSessionsByProject).toHaveBeenCalledWith("p1"));
    act(() => pop("/p/p2/s/s2"));
    await waitFor(() => expect(ApiClient.prototype.listSessionsByProject).toHaveBeenCalledWith("p2"));
    await act(async () => current.reject(new ApiError(503, "current"))); await selected(result, null);
    await act(async () => old.reject(new ApiError(status, "old")));
    expect(result.current.loadError).toBe("current"); expect(result.current.navigationRetryAvailable).toBe(true);
    expect(path()).toBe("/p/p2/s/s2");
  });
  it("encodes and decodes IDs as segments", () => {
    writeRoute({ projectId: "a/b 空", sessionId: "s?#%" }, "replace");
    expect(readRoute()).toEqual({ projectId: "a/b 空", sessionId: "s?#%" });
  });
});
