import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiClient, ApiError, createSseConnection, type SessionRecord } from "pi-agent-server/client";
import { useWebAppController } from "./hooks/useWebAppController.js";
vi.mock("pi-agent-server/client", async original => ({
  ...await original<typeof import("pi-agent-server/client")>(),
  createSseConnection: vi.fn(() => ({ close() {} })),
}));
const session: SessionRecord = { id: "s1", projectId: "p1", ownerKey: "fixture", title: "", createdAt: 1, updatedAt: 1,
  modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
function deferred() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  localStorage.clear(); vi.mocked(createSseConnection).mockClear();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network"); }));
  vi.spyOn(ApiClient.prototype, "getAccess").mockResolvedValue({ canRead: true, canWrite: true });
  vi.spyOn(ApiClient.prototype, "listProjects").mockResolvedValue([{ id: "p1", name: "Default", cwd: "/fixture", isDefault: true }]);
  vi.spyOn(ApiClient.prototype, "listSessionsByProject").mockResolvedValue([session, { ...session, id: "s2" }]);
  vi.spyOn(ApiClient.prototype, "listModels").mockResolvedValue({ models: [], thinkingLevels: [], defaultModel: null, defaultThinkingLevel: "off" });
  vi.spyOn(ApiClient.prototype, "exportSession").mockResolvedValue({ messages: [], timeline: [], lastEventId: 0 });
  vi.spyOn(ApiClient.prototype, "steer").mockResolvedValue(undefined);
  vi.spyOn(ApiClient.prototype, "followUp").mockResolvedValue(undefined);
  vi.spyOn(ApiClient.prototype, "abort").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup(withImage = false) {
  const hook = renderHook(useWebAppController);
  await waitFor(() => expect(hook.result.current.sessions).not.toBeNull());
  act(() => hook.result.current.selectSession("s1"));
  await waitFor(() => expect(createSseConnection).toHaveBeenCalled());
  const connection = vi.mocked(createSseConnection).mock.calls.at(-1)![0];
  act(() => connection.onEvent({ type: "status", phase: "agent_start", requestId: "r1" }, 1));
  act(() => {
    if (withImage) hook.result.current.draftSource.update("session:s1", current => ({ ...current, attachments: [
      { localId: "original-image", kind: "image", status: "ready", name: "original.png", mediaType: "image/png", size: 1,
        image: { mediaType: "image/png", base64: "AA==", preview: "data:image/png;base64,AA==" } },
    ] }));
    hook.result.current.setUnsentText("unconsumed"); hook.result.current.steer("unconsumed");
  });
  return { ...hook, connection };
}
it("settles an accepted steering control only on the matching aborted SSE", async () => {
  const { result, connection } = await setup();
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  await act(async () => { result.current.abort(); await Promise.resolve(); });
  expect(result.current.pendingControls).toHaveLength(1);
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 2));
  expect(result.current.pendingControls).toEqual([]);
  expect(result.current.draftSource.getSnapshot("session:s1").text).toBe("unconsumed");
});

it.each(["completed", "error"] as const)("clears matching %s terminals as well", async type => {
  const { result, connection } = await setup();
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  act(() => connection.onEvent(type === "error" ? { type, requestId: "r1", message: "failed" } : { type, requestId: "r1" }, 2));
  expect(result.current.pendingControls).toEqual([]);
  expect(result.current.draftSource.getSnapshot("session:s1").text).toBe("unconsumed");
});

it.each(["202", "rejection"] as const)("does not resurrect a cancelled in-flight control on late %s", async outcome => {
  const pending = deferred();
  vi.mocked(ApiClient.prototype.steer).mockReturnValueOnce(pending.promise);
  const { result, connection } = await setup();
  const oldId = result.current.pendingControls[0]!.id;
  expect(result.current.pendingControls[0]?.status).toBe("submitting");
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 2));
  expect(result.current.pendingControls).toEqual([]);
  act(() => connection.onEvent({ type: "status", phase: "agent_start", requestId: "r2" }, 3));
  // Same text/revision is now eligible again; transport identity must be new.
  act(() => result.current.steer("unconsumed"));
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  const newId = result.current.pendingControls[0]!.id;
  expect(newId).not.toBe(oldId);
  await act(async () => {
    if (outcome === "202") pending.resolve();
    else pending.reject(new ApiError(409, "late rejection"));
    await pending.promise.catch(() => {});
  });
  expect(result.current.pendingControls).toHaveLength(1);
  expect(result.current.pendingControls[0]).toMatchObject({ id: newId, requestId: "r2", status: "submitted" });
  act(() => result.current.steer("unconsumed"));
  expect(ApiClient.prototype.steer).toHaveBeenCalledTimes(2);
});

it("retains pending controls when the abort API fails", async () => {
  vi.mocked(ApiClient.prototype.abort).mockRejectedValue(new ApiError(500, "abort failed"));
  const { result } = await setup();
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  act(() => result.current.abort());
  await waitFor(() => expect(result.current.chatState.error).toBe("abort failed"));
  expect(result.current.pendingControls).toHaveLength(1);
  expect(result.current.draftSource.getSnapshot("session:s1").text).toBe("unconsumed");
});

it("ignores foreign/missing-ID terminals, notifications and disconnects", async () => {
  const { result, connection } = await setup();
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  act(() => {
    connection.onEvent({ type: "aborted", requestId: "other" }, 2);
    connection.onEvent({ type: "completed", requestId: "other" }, 3);
    connection.onEvent({ type: "error", requestId: "other", message: "foreign" }, 4);
    connection.onEvent({ type: "aborted" }, 5);
    connection.onEvent({ type: "completed" }, 6);
    connection.onEvent({ type: "error", message: "legacy" }, 7);
    connection.onEvent({ type: "notification", version: 1, notificationId: "n1", entryId: "e1", text: "notice", runIds: [], timestamp: "" }, 8);
    connection.onEvent({ type: "compaction_end", requestId: "r1", reason: "manual", outcome: "aborted", willRetry: false }, 9);
    connection.onDisconnect?.();
  });
  expect(result.current.pendingControls).toHaveLength(1);
  act(() => result.current.steer("unconsumed"));
  expect(ApiClient.prototype.steer).toHaveBeenCalledTimes(1);
});

it("does not let an old request terminal clear a new request control or followUp", async () => {
  const { result, connection } = await setup();
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 2));
  act(() => connection.onEvent({ type: "status", phase: "agent_start", requestId: "r2" }, 3));
  act(() => { result.current.steer("unconsumed"); result.current.followUp("later"); });
  await waitFor(() => expect(result.current.pendingControls.every(row => row.status === "submitted")).toBe(true));
  expect(result.current.pendingControls).toHaveLength(2);
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 4));
  expect(result.current.pendingControls).toHaveLength(2);
  act(() => connection.onEvent({ type: "aborted", requestId: "r2" }, 5));
  expect(result.current.pendingControls.map(row => row.kind)).toEqual(["followUp"]);
});

it("clears only old r1 pending when its terminal arrives while r2 pending is active", async () => {
  vi.spyOn(ApiClient.prototype, "sendMessage").mockResolvedValue(undefined);
  const { result, connection } = await setup();
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  const oldId = result.current.pendingControls[0]!.id;
  // Normal submission establishes a new request owner without delivering r1's terminal.
  await act(async () => { await result.current.sendMessage("next request"); });
  const requestId = result.current.chatState.activeRequestId!;
  expect(requestId).not.toBe("r1");
  act(() => connection.onEvent({ type: "status", phase: "agent_start", requestId }, 2));
  act(() => { result.current.setUnsentText("new steer"); result.current.steer("new steer"); });
  await waitFor(() => expect(result.current.pendingControls).toHaveLength(2));
  const newId = result.current.pendingControls[1]!.id;
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 3));
  expect(result.current.pendingControls.map(row => row.id)).toEqual([newId]);
  expect(result.current.pendingControls.some(row => row.id === oldId)).toBe(false);
  expect(result.current.chatState.activeRequestId).toBe(requestId);
  expect(result.current.chatState.phase).toBe("streaming");
  expect(result.current.draftSource.getSnapshot("session:s1").text).toBe("new steer");
  act(() => result.current.steer("new steer"));
  expect(ApiClient.prototype.steer).toHaveBeenCalledTimes(2); // r2 lock remains held.
});

it("isolates terminal cleanup across session selection and replay", async () => {
  const { result, connection } = await setup();
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  act(() => result.current.selectSession("s2"));
  await waitFor(() => expect(vi.mocked(createSseConnection).mock.calls).toHaveLength(2));
  const second = vi.mocked(createSseConnection).mock.calls.at(-1)![0];
  act(() => second.onEvent({ type: "status", phase: "agent_start", requestId: "r1" }, 1));
  act(() => { result.current.setUnsentText("second"); result.current.steer("second"); });
  await waitFor(() => expect(result.current.pendingControls[0]?.status).toBe("submitted"));
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 2)); // Closed callback cannot affect s2.
  expect(result.current.pendingControls).toHaveLength(1);
  act(() => second.onEvent({ type: "aborted", requestId: "r1" }, 2));
  expect(result.current.pendingControls).toEqual([]);
  act(() => result.current.selectSession("s1"));
  await waitFor(() => expect(vi.mocked(createSseConnection).mock.calls).toHaveLength(3));
  expect(result.current.pendingControls).toHaveLength(1); // s2 terminal did not clear s1.
  const replay = vi.mocked(createSseConnection).mock.calls.at(-1)![0];
  act(() => replay.onEvent({ type: "aborted", requestId: "r1" }, 2));
  expect(result.current.pendingControls).toEqual([]);
  expect(result.current.draftSource.getSnapshot("session:s2").text).toBe("second");
});

it("does not retract a consumed message on abort or clear a later draft", async () => {
  const { result, connection } = await setup();
  const control = result.current.pendingControls[0]!;
  const consumed = { type: "steering_consumed" as const, controlId: control.id,
    requestId: "r1", acknowledgementId: control.acknowledgementId!, message: { sourceId: "m1", text: "unconsumed" } };
  act(() => connection.onEvent(consumed, 2));
  expect(result.current.pendingControls).toEqual([]);
  expect(result.current.draftSource.getSnapshot("session:s1").text).toBe("");
  act(() => result.current.setUnsentText("new draft"));
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 3));
  act(() => connection.onEvent(consumed, 4));
  expect(result.current.draftSource.getSnapshot("session:s1").text).toBe("new draft");
  expect(result.current.chatState.timeline.filter(row => row.id === "history-message:m1")).toHaveLength(1);
});

it("keeps the original unedited text and captured image on terminal cancellation", async () => {
  const { result, connection } = await setup(true);
  const draft = result.current.draftSource.getSnapshot("session:s1");
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 2));
  expect(result.current.pendingControls).toEqual([]);
  expect(result.current.draftSource.getSnapshot("session:s1")).toBe(draft);
  act(() => connection.onEvent({ type: "status", phase: "agent_start", requestId: "r2" }, 3));
  act(() => result.current.steer("unconsumed"));
  expect(ApiClient.prototype.steer).toHaveBeenCalledTimes(2);
});

it.each(["edited", ""])("preserves the current draft %j and attachments, even on late consumption", async text => {
  const { result, connection } = await setup(true);
  const control = result.current.pendingControls[0]!;
  act(() => {
    result.current.setUnsentText(text);
    result.current.draftSource.update("session:s1", current => ({ ...current, attachments: [
      { localId: "new-image", kind: "image", status: "ready", name: "new.png", mediaType: "image/png", size: 1,
        image: { mediaType: "image/png", base64: "AA==", preview: "data:image/png;base64,AA==" } },
    ] }));
  });
  const draft = result.current.draftSource.getSnapshot("session:s1");
  act(() => connection.onEvent({ type: "aborted", requestId: "r1" }, 2));
  act(() => connection.onEvent({ type: "steering_consumed", controlId: control.id, requestId: "r1",
    acknowledgementId: control.acknowledgementId!, message: { sourceId: "late", text: "unconsumed" } }, 3));
  expect(result.current.pendingControls).toEqual([]);
  expect(result.current.draftSource.getSnapshot("session:s1")).toBe(draft);
});
