import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClient, ApiError, createSseConnection, type SseEvent, type SessionRecord } from "pi-agent-server/client";
import { useWebAppController } from "./hooks/useWebAppController.js";
import { readRecentSelection } from "./recent-selection.js";

vi.mock("pi-agent-server/client", async original => ({
  ...await original<typeof import("pi-agent-server/client")>(),
  createSseConnection: vi.fn(() => ({ close() {} })),
}));
const created: SessionRecord = { id: "created", projectId: "p1", ownerKey: "fixture", title: "", createdAt: 1, updatedAt: 1,
  modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
const draft = (controller: ReturnType<typeof useWebAppController>, scope = controller.draftScope) => controller.draftSource.getSnapshot(scope);
const attachment = (name: string, kind: "image" | "file") => new File([name], `${name}.${kind === "image" ? "png" : "txt"}`, { type: kind === "image" ? "image/png" : "text/plain" });
beforeEach(() => {
  localStorage.clear();
  vi.mocked(createSseConnection).mockClear();
  // No live transport, home, credentials, models DB, or SDK involved.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected fixture network request"); }));
  vi.spyOn(ApiClient.prototype, "getAccess").mockResolvedValue({ canRead: true, canWrite: true });
  vi.spyOn(ApiClient.prototype, "listProjects").mockResolvedValue([
    { id: "p1", name: "Default", cwd: "/fixture/p1", isDefault: true },
    { id: "p2", name: "Other", cwd: "/fixture/p2", isDefault: false },
  ]);
  vi.spyOn(ApiClient.prototype, "listSessionsByProject").mockResolvedValue([]);
  vi.spyOn(ApiClient.prototype, "listModels").mockResolvedValue({ models: [], thinkingLevels: [], defaultModel: null, defaultThinkingLevel: "off" });
  vi.spyOn(ApiClient.prototype, "createSession").mockResolvedValue(created);
  vi.spyOn(ApiClient.prototype, "updateSessionConfig").mockResolvedValue(created);
  vi.spyOn(ApiClient.prototype, "sendMessage").mockResolvedValue(undefined);
  vi.spyOn(ApiClient.prototype, "exportSession").mockResolvedValue({ messages: [], timeline: [], lastEventId: 0 });
  vi.spyOn(ApiClient.prototype, "uploadFile").mockImplementation(async input => ({
    fileId: `file-${input.name}`, name: input.name, mediaType: input.mediaType, size: input.bytes.length,
    status: "ready", agentPath: `/fixture/${input.name}`,
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup(kind: "image" | "file") {
  const hook = renderHook(useWebAppController, { wrapper });
  await waitFor(() => expect(hook.result.current.sessions).not.toBeNull());
  act(() => { hook.result.current.setUnsentText("A"); hook.result.current.setNewSessionSettings({ thinkingLevel: "low" }); });
  await act(async () => hook.result.current.addUnsentFile(attachment("X", kind)));
  return hook;
}
describe("pending first-create snapshot ownership", () => {
  it.each(["image", "file"] as const)("migrates edited B + new %s Y, consumes only X and does not resend X", async kind => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); });
    expect(result.current.submitState?.phase).toBe("creating");
    act(() => result.current.setUnsentText("B"));
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    await act(async () => { creation.resolve(created); expect(await sending).toBe(true); });
    expect(result.current.activeSessionId).toBe("created");
    expect(draft(result.current).text).toBe("B");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual([`Y.${kind === "image" ? "png" : "txt"}`]);
    expect(draft(result.current, "new:p1").attachments).toEqual([]);
    await waitFor(() => expect(result.current.historyLoading).toBe(false));
    await act(async () => expect(await result.current.sendMessage("B")).toBe(true));
    const calls = vi.mocked(ApiClient.prototype.sendMessage).mock.calls;
    expect(calls.map(call => call[1].prompt)).toEqual(["A", "B"]);
    if (kind === "file") expect(calls.map(call => call[1].fileIds)).toEqual([["file-X.txt"], ["file-Y.txt"]]);
    else expect(calls.map(call => call[1].images)).toEqual([
      [{ mediaType: "image/png", base64: btoa("X") }], [{ mediaType: "image/png", base64: btoa("Y") }],
    ]);
    expect(ApiClient.prototype.createSession).toHaveBeenCalledTimes(1);
    expect(ApiClient.prototype.updateSessionConfig).toHaveBeenCalledTimes(1);
    act(() => result.current.createSession());
    expect(draft(result.current).attachments).toEqual([]);
    expect(readRecentSelection()).toEqual({ version: 1, projectId: "p1", sessionId: null });
  });

  it.each(["image", "file"] as const)("navigated owner removes accepted %s X without clearing B or another project", async kind => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    act(() => result.current.selectProject("p2"));
    act(() => result.current.setUnsentText("other project"));
    await act(async () => result.current.addUnsentFile(attachment("Z", kind)));
    const other = draft(result.current);
    await act(async () => { creation.resolve(created); expect(await sending).toBe(true); });
    expect(result.current.activeProjectId).toBe("p2");
    expect(result.current.activeSessionId).toBeNull();
    expect(draft(result.current)).toBe(other);
    expect(draft(result.current, "new:p1").text).toBe("B");
    expect(draft(result.current, "new:p1").attachments.map(item => item.name)).toEqual([`Y.${kind === "image" ? "png" : "txt"}`]);
    expect(draft(result.current, "session:created").attachments).toEqual([]);
    expect(ApiClient.prototype.sendMessage).toHaveBeenCalledWith("created", expect.objectContaining({ prompt: "A" }));
  });

  it.each(["image", "file"] as const)("selecting another session leaves its %s draft untouched on accepted creation", async kind => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    act(() => result.current.selectSession("other-session"));
    act(() => result.current.setUnsentText("other session draft"));
    await act(async () => result.current.addUnsentFile(attachment("Z", kind)));
    const other = draft(result.current);
    await act(async () => { creation.resolve(created); expect(await sending).toBe(true); });
    expect(result.current.activeSessionId).toBe("other-session");
    expect(draft(result.current)).toBe(other);
    expect(draft(result.current, "new:p1").text).toBe("B");
    expect(draft(result.current, "new:p1").attachments.map(item => item.name)).toEqual([`Y.${kind === "image" ? "png" : "txt"}`]);
    expect(readRecentSelection()?.sessionId).toBe("other-session");
  });

  it.each(["image", "file"] as const)("explicit blank navigation keeps edited %s owner and does not let creation steal selection", async kind => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.createSession(); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    await act(async () => { creation.resolve(created); await sending; });
    expect(result.current.activeSessionId).toBeNull();
    expect(draft(result.current).text).toBe("B");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual([`Y.${kind === "image" ? "png" : "txt"}`]);
    expect(readRecentSelection()?.sessionId).toBeNull();
  });

  it.each(["image", "file"] as const)("known send failure retains %s snapshot; explicit retry does not recreate or reconfigure", async kind => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    vi.mocked(ApiClient.prototype.sendMessage).mockRejectedValueOnce(new ApiError(400, "rejected"));
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    await act(async () => { creation.resolve(created); expect(await sending).toBe(false); });
    expect(result.current.submitState?.phase).toBe("failed");
    expect(draft(result.current).attachments).toHaveLength(2);
    const snapshot = result.current.submitState!.snapshot;
    expect(snapshot.text).toBe("A"); expect(snapshot.localIds).toHaveLength(1);
    await act(async () => expect(await result.current.retryFailedSubmission()).toBe("accepted"));
    expect(vi.mocked(ApiClient.prototype.sendMessage).mock.calls[1]).toEqual(vi.mocked(ApiClient.prototype.sendMessage).mock.calls[0]);
    expect(ApiClient.prototype.createSession).toHaveBeenCalledTimes(1);
    expect(ApiClient.prototype.updateSessionConfig).toHaveBeenCalledTimes(1);
    expect(draft(result.current).text).toBe("B");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual([`Y.${kind === "image" ? "png" : "txt"}`]);
  });

  it.each(["image", "file"] as const)("unknown send preserves %s snapshot and inputs without automatic resend", async kind => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    vi.mocked(ApiClient.prototype.sendMessage).mockRejectedValueOnce(new Error("lost response"));
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    await act(async () => { creation.resolve(created); expect(await sending).toBe(false); });
    expect(result.current.submitState?.phase).toBe("unknown");
    expect(result.current.submitState?.snapshot.text).toBe("A");
    expect(result.current.submitState?.snapshot.localIds).toHaveLength(1);
    expect(draft(result.current).text).toBe("B"); expect(draft(result.current).attachments).toHaveLength(2);
    await act(async () => expect(await result.current.sendMessage("B")).toBe(false));
    expect(ApiClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.chatState.timeline.filter(item => item.kind === "message" && item.role === "user")).toEqual([]);
  });

  it.each([
    ["image", "queued", "http-first"], ["image", "status", "http-first"],
    ["file", "queued", "http-first"], ["file", "status", "http-first"],
    ["image", "queued", "sse-first"], ["image", "status", "sse-first"],
    ["file", "queued", "sse-first"], ["file", "status", "sse-first"],
  ] as const)("navigated %s owner confirms by %s (%s), once and only by transport identity", async (kind, type, order) => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    const response = deferred<void>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    vi.mocked(ApiClient.prototype.sendMessage).mockReturnValueOnce(response.promise);
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    act(() => result.current.selectProject("p2"));
    act(() => result.current.setUnsentText("other project"));
    const other = draft(result.current);
    await act(async () => creation.resolve(created));
    await waitFor(() => expect(ApiClient.prototype.sendMessage).toHaveBeenCalledTimes(1));
    expect(result.current.activeProjectId).toBe("p2");
    expect(result.current.activeSessionId).toBeNull();
    expect(draft(result.current)).toBe(other);
    const requestId = vi.mocked(ApiClient.prototype.sendMessage).mock.calls[0]![1].requestId;
    const event = (id = requestId): SseEvent => type === "queued"
      ? { type: "queued", requestId: id } : { type: "status", phase: "agent_start", requestId: id };
    if (order === "http-first") await act(async () => { response.reject(new Error("lost response")); expect(await sending).toBe(false); });
    // Wrong session, even with the exact request id, cannot consume the original owner's input.
    act(() => result.current.selectSession("wrong-session"));
    await waitFor(() => expect(vi.mocked(createSseConnection).mock.calls.some(([options]) => options.url.includes("wrong-session"))).toBe(true));
    const wrong = [...vi.mocked(createSseConnection).mock.calls].reverse().find(([options]) => options.url.includes("wrong-session"))![0];
    act(() => wrong.onEvent(event(), 1));
    expect(draft(result.current, "new:p1").attachments).toHaveLength(2);
    // Revisit the receiving session; the immutable submission still belongs to new:p1.
    act(() => result.current.selectProject("p1"));
    await waitFor(() => expect(result.current.sessions).not.toBeNull());
    act(() => result.current.selectSession("created"));
    await waitFor(() => expect(vi.mocked(createSseConnection).mock.calls.some(([options]) => options.url.includes("/created/"))).toBe(true));
    const connection = [...vi.mocked(createSseConnection).mock.calls].reverse().find(([options]) => options.url.includes("/created/"))![0];
    act(() => connection.onEvent(event("wrong-request"), 2));
    expect(draft(result.current, "new:p1").attachments).toHaveLength(2);
    // A text rollback leaves an idle store, which may legitimately receive another lifecycle.
    // Finish that lifecycle before replaying the original; never bypass active-request ownership.
    act(() => connection.onEvent({ type: "aborted", requestId: "wrong-request" }, 2));
    act(() => connection.onEvent(event(), 3));
    if (order === "sse-first") await act(async () => { response.reject(new Error("lost response")); expect(await sending).toBe(true); });
    act(() => connection.onEvent(event(), 4));
    expect(result.current.activeSessionId).toBe("created");
    const messages = result.current.chatState.timeline.filter(item => item.kind === "message" && item.role === "user");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "A" });
    if (kind === "image") expect(messages[0]).toMatchObject({ images: [{ mediaType: "image/png", base64: btoa("X") }] });
    // Foreign terminal events still cannot finish this request.
    act(() => connection.onEvent({ type: "completed", requestId: "foreign" }, 5));
    expect(result.current.chatState.activeRequestId).toBe(requestId);
    act(() => result.current.selectSession(null));
    expect(result.current.submitState?.phase).toBe("accepted");
    expect(result.current.submitState?.snapshot.scope).toBe("new:p1");
    expect(draft(result.current).text).toBe("B");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual([kind === "image" ? "Y.png" : "Y.txt"]);
    expect(draft(result.current, "new:p2")).toBe(other);
    await act(async () => expect(await result.current.sendMessage("B")).toBe(true));
    expect(vi.mocked(ApiClient.prototype.sendMessage).mock.calls.map(([, payload]) => payload.prompt)).toEqual(["A", "B"]);
  });

  it.each([
    ["image", "queued", "reject"], ["image", "status", "reject"],
    ["file", "queued", "reject"], ["file", "status", "reject"],
    ["image", "queued", "resolve"], ["image", "status", "resolve"],
    ["file", "queued", "resolve"], ["file", "status", "resolve"],
  ] as const)("retains %s %s receipt across another navigation and scope send before HTTP %s", async (kind, type, outcome) => {
    const { result } = await setup(kind);
    const creation = deferred<SessionRecord>();
    const response = deferred<void>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise)
      .mockResolvedValueOnce({ ...created, id: "other-created", projectId: "p2" });
    vi.mocked(ApiClient.prototype.sendMessage).mockReturnValueOnce(response.promise);
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", kind)));
    act(() => result.current.selectProject("p2"));
    await act(async () => creation.resolve(created));
    await waitFor(() => expect(ApiClient.prototype.sendMessage).toHaveBeenCalledTimes(1));
    const requestId = vi.mocked(ApiClient.prototype.sendMessage).mock.calls[0]![1].requestId;
    act(() => result.current.selectProject("p1"));
    await waitFor(() => expect(result.current.sessions).not.toBeNull());
    act(() => result.current.selectSession("created"));
    await waitFor(() => expect(vi.mocked(createSseConnection).mock.calls.some(([options]) => options.url.includes("/created/"))).toBe(true));
    const connection = [...vi.mocked(createSseConnection).mock.calls].reverse().find(([options]) => options.url.includes("/created/"))![0];
    const event: SseEvent = type === "queued" ? { type, requestId } : { type, phase: "agent_start", requestId };
    act(() => connection.onEvent(event, 1));
    // Consume the ack cursor, then leave again while the original HTTP is still pending.
    act(() => result.current.selectProject("p2"));
    await waitFor(() => expect(result.current.sessions).not.toBeNull());
    act(() => result.current.setUnsentText("other project"));
    await act(async () => result.current.addUnsentFile(attachment("Z", kind)));
    await act(async () => expect(await result.current.sendMessage("other project")).toBe(true));
    const other = draft(result.current);
    await act(async () => {
      if (outcome === "reject") response.reject(new Error("lost response"));
      else response.resolve();
      expect(await sending).toBe(true);
    });
    expect(result.current.activeSessionId).toBe("other-created");
    expect(draft(result.current)).toBe(other);
    expect(result.current.submitState?.phase).toBe("accepted");
    expect(draft(result.current, "new:p1").text).toBe("B");
    expect(draft(result.current, "new:p1").attachments.map(item => item.name)).toEqual([kind === "image" ? "Y.png" : "Y.txt"]);
    act(() => result.current.selectProject("p1"));
    await waitFor(() => expect(result.current.sessions).not.toBeNull());
    act(() => result.current.selectSession("created"));
    await waitFor(() => expect(vi.mocked(createSseConnection).mock.calls.filter(([options]) => options.url.includes("/created/")).length).toBe(2));
    const revisited = [...vi.mocked(createSseConnection).mock.calls].reverse().find(([options]) => options.url.includes("/created/"))![0];
    expect(revisited.lastEventId).toBe(1);
    // No ack replay is needed for acceptance; duplicate/foreign events cannot duplicate X or close its flow.
    expect(result.current.chatState.timeline.filter(item => item.kind === "message" && item.role === "user")).toHaveLength(1);
    act(() => { revisited.onEvent(event, 2); revisited.onEvent({ type: "completed", requestId: "foreign" }, 3); });
    expect(result.current.chatState.activeRequestId).toBe(requestId);
    expect(result.current.chatState.timeline.filter(item => item.kind === "message" && item.role === "user")).toHaveLength(1);
    act(() => result.current.selectSession(null));
    expect(result.current.submitState?.phase).toBe("accepted");
    await act(async () => expect(await result.current.sendMessage("B")).toBe(true));
    expect(vi.mocked(ApiClient.prototype.sendMessage).mock.calls.map(([, payload]) => payload.prompt)).toEqual(["A", "other project", "B"]);
    const payload = vi.mocked(ApiClient.prototype.sendMessage).mock.calls[2]![1];
    if (kind === "file") expect(payload.fileIds).toEqual(["file-Y.txt"]);
    else expect(payload.images).toEqual([{ mediaType: "image/png", base64: btoa("Y") }]);
  });

  it("finishing Y upload updates its migrated owner, never the new blank draft", async () => {
    const { result } = await setup("file");
    const creation = deferred<SessionRecord>();
    const upload = deferred<Awaited<ReturnType<ApiClient["uploadFile"]>>>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    vi.mocked(ApiClient.prototype.uploadFile).mockReturnValueOnce(upload.promise);
    let sending!: Promise<boolean>, adding!: Promise<void>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); adding = result.current.addUnsentFile(attachment("Y", "file")); });
    await waitFor(() => expect(ApiClient.prototype.uploadFile).toHaveBeenCalledTimes(2));
    await act(async () => { creation.resolve(created); await sending; });
    expect(draft(result.current).attachments.map(item => [item.name, item.status])).toEqual([["Y.txt", "uploading"]]);
    act(() => result.current.createSession());
    act(() => result.current.setUnsentText("new blank"));
    await act(async () => {
      upload.resolve({ fileId: "file-Y.txt", name: "Y.txt", mediaType: "text/plain", size: 1, status: "ready", agentPath: "/fixture/Y.txt" });
      await adding;
    });
    expect(draft(result.current).text).toBe("new blank");
    expect(draft(result.current).attachments).toEqual([]);
    expect(draft(result.current, "session:created").attachments.map(item => [item.name, item.status])).toEqual([["Y.txt", "ready"]]);
  });

  it("navigated failed send retains original scope for explicit retry without recopying or reconfiguring", async () => {
    const { result } = await setup("image");
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    vi.mocked(ApiClient.prototype.sendMessage).mockRejectedValueOnce(new ApiError(400, "rejected"));
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", "image")));
    act(() => result.current.selectProject("p2"));
    await act(async () => { creation.resolve(created); await sending; });
    act(() => result.current.selectProject("p1"));
    expect(result.current.submitState?.phase).toBe("failed");
    expect(result.current.submitState?.snapshot.scope).toBe("new:p1");
    expect(draft(result.current).attachments).toHaveLength(2);
    await act(async () => expect(await result.current.retryFailedSubmission()).toBe("accepted"));
    expect(result.current.activeSessionId).toBeNull();
    expect(draft(result.current).text).toBe("B");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual(["Y.png"]);
    expect(ApiClient.prototype.createSession).toHaveBeenCalledTimes(1);
    expect(ApiClient.prototype.updateSessionConfig).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ApiClient.prototype.sendMessage).mock.calls[1]).toEqual(vi.mocked(ApiClient.prototype.sendMessage).mock.calls[0]);
  });

  it("configuration failure retains images and retries configuration without recreating the session", async () => {
    const { result } = await setup("image");
    vi.mocked(ApiClient.prototype.updateSessionConfig).mockRejectedValueOnce(new ApiError(400, "bad config"));
    await act(async () => expect(await result.current.sendMessage("A")).toBe(false));
    expect(result.current.submitState?.stage).toBe("config");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual(["X.png"]);
    expect(ApiClient.prototype.sendMessage).not.toHaveBeenCalled();
    act(() => result.current.setUnsentText("B"));
    await act(async () => result.current.addUnsentFile(attachment("Y", "image")));
    await act(async () => expect(await result.current.retryFailedSubmission()).toBe("accepted"));
    expect(ApiClient.prototype.createSession).toHaveBeenCalledTimes(1);
    expect(ApiClient.prototype.updateSessionConfig).toHaveBeenCalledTimes(2);
    expect(ApiClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(draft(result.current).text).toBe("B");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual(["Y.png"]);
  });

  it.each(["failed", "unknown"] as const)("%s creation explicitly retries original immutable snapshot and create key", async outcome => {
    const { result } = await setup("image");
    const creation = deferred<SessionRecord>();
    vi.mocked(ApiClient.prototype.createSession).mockReturnValueOnce(creation.promise);
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("A"); result.current.setUnsentText("B"); });
    await act(async () => result.current.addUnsentFile(attachment("Y", "image")));
    await act(async () => { creation.reject(outcome === "failed" ? new ApiError(400, "rejected") : new Error("lost")); await sending; });
    expect(result.current.submitState?.phase).toBe(outcome);
    expect(draft(result.current).attachments).toHaveLength(2);
    await act(async () => expect(await (outcome === "failed" ? result.current.retryFailedSubmission() : result.current.confirmUnknownCreation())).toBe("accepted"));
    const calls = vi.mocked(ApiClient.prototype.createSession).mock.calls;
    expect(calls[1]).toEqual(calls[0]);
    expect(ApiClient.prototype.updateSessionConfig).toHaveBeenCalledTimes(1);
    expect(ApiClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ApiClient.prototype.sendMessage).mock.calls[0][1]).toMatchObject({ prompt: "A", images: [{ mediaType: "image/png", base64: btoa("X") }] });
    expect(draft(result.current).text).toBe("B");
    expect(draft(result.current).attachments.map(item => item.name)).toEqual(["Y.png"]);
  });
});
