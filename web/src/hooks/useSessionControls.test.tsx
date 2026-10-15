import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiClient, ApiError, createChatStore, type ControlQueueSnapshot } from "pi-agent-server/client";
import { useSessionControls } from "./useSessionControls.js";
import { EMPTY_MESSAGE, type SubmitSnapshot, type UnsentMessage } from "../attachment-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const empty: ControlQueueSnapshot = { requestId: "r1", revision: 0, items: [] };
function queue(revision: number, id = "remote", kind: "steer" | "followUp" = "followUp", acknowledgementId = "ack"): ControlQueueSnapshot {
  return { requestId: "r1", revision, items: [{ id, kind, acknowledgementId, status: "queued", text: "resident", hasImages: false }] };
}
beforeEach(() => {
  vi.spyOn(ApiClient.prototype, "getControlQueue").mockResolvedValue(empty);
  vi.spyOn(ApiClient.prototype, "steer").mockResolvedValue(undefined);
  vi.spyOn(ApiClient.prototype, "followUp").mockResolvedValue(undefined);
  vi.spyOn(ApiClient.prototype, "deleteControl").mockResolvedValue({ ...empty, revision: 2 });
  vi.spyOn(ApiClient.prototype, "promoteControl").mockResolvedValue(queue(2, "remote", "steer"));
});
afterEach(() => vi.restoreAllMocks());
function setup() {
  const stores = new Map([["s1", createChatStore()], ["s2", createChatStore()]]);
  for (const store of stores.values()) store.applyEvent({ type: "status", phase: "agent_start", requestId: "r1" });
  let draft: UnsentMessage = { ...EMPTY_MESSAGE, text: "original" };
  const draftTextRevisionsRef = { current: new Map([["session:s1", 1]]) };
  const captureSnapshot = vi.fn((scope: string, text: string): SubmitSnapshot => ({ scope, text, projectId: "p1", sessionId: scope.slice(8), requestId: "unused", createRequestId: "unused", localIds: draft.attachments.map(item => item.localId),
    fileIds: [], images: draft.attachments.flatMap(item => item.image ? [{ mediaType: item.image.mediaType, base64: item.image.base64 }] : []), settings: {} }));
  const options: Parameters<typeof useSessionControls>[0] = {
    api: new ApiClient({ baseUrl: "" }), activeSessionId: "s1", navigationGeneration: 0, canWrite: true, historyLoading: false,
    captureSnapshot, getChatStore: id => stores.get(id)!, draftTextRevisionsRef, primarySubmissionBlocked: () => false,
    updateUnsent: vi.fn((_scope, change) => { draft = change(draft); }), reportChatError: vi.fn(),
  };
  const hook = renderHook(useSessionControls, { initialProps: options });
  const event = (snapshot: ControlQueueSnapshot) => act(() => hook.result.current.applyControlEvent("s1", stores.get("s1")!, { type: "control_queue", ...snapshot }));
  return { ...hook, options, stores, event, captureSnapshot, draftTextRevisionsRef,
    draft: () => draft, edit: (text: string) => { draft = { ...draft, text }; draftTextRevisionsRef.current.set("session:s1", (draftTextRevisionsRef.current.get("session:s1") ?? 0) + 1); },
    image: (localId = "image") => { draft = { ...draft, attachments: [...draft.attachments, { localId, kind: "image", name: "image.png", size: 1, status: "ready", mediaType: "image/png", image: { mediaType: "image/png", base64: "AA==", preview: "data:image/png;base64,AA==" } }] }; },
  };
}

it("checks the live primary gate before capturing controls, including stale handlers", async () => {
  const hook = setup();
  const blocked = vi.fn(() => true);
  hook.rerender({ ...hook.options, primarySubmissionBlocked: blocked });
  const staleSteer = hook.result.current.steer;
  const staleFollowUp = hook.result.current.followUp;
  act(() => { staleSteer("original"); staleFollowUp("original"); });
  expect(blocked).toHaveBeenCalledWith("s1");
  expect(hook.captureSnapshot).not.toHaveBeenCalled();
  expect(ApiClient.prototype.steer).not.toHaveBeenCalled();
  expect(ApiClient.prototype.followUp).not.toHaveBeenCalled();
  // The synchronous primary owner releases admission only after clearing its snapshot.
  blocked.mockReturnValue(false);
  hook.edit("new intentional guide");
  act(() => staleSteer("new intentional guide"));
  await waitFor(() => expect(ApiClient.prototype.steer).toHaveBeenCalledTimes(1));
});

it("restores server-resident items from GET without local submissions", async () => {
  vi.mocked(ApiClient.prototype.getControlQueue).mockResolvedValue(queue(4));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.controlQueue?.revision).toBe(4));
  expect(hook.result.current.pendingControls).toEqual([]);
  expect(hook.result.current.controlQueue?.items[0]?.id).toBe("remote");
});

it("ignores a malformed control-queue body instead of crashing", async () => {
  vi.mocked(ApiClient.prototype.getControlQueue).mockResolvedValue({ error: "not found" } as unknown as ControlQueueSnapshot);
  const hook = setup();
  await waitFor(() => expect(ApiClient.prototype.getControlQueue).toHaveBeenCalled());
  expect(hook.result.current.controlQueue ?? null).toBeNull();
  expect(hook.result.current.pendingControls).toEqual([]);
});

it("rejects stale GET and SSE revisions, and ignores a previous selection's late GET", async () => {
  const pending = deferred<ControlQueueSnapshot>();
  vi.mocked(ApiClient.prototype.getControlQueue).mockReturnValueOnce(pending.promise);
  const hook = setup();
  hook.event(queue(5));
  await act(async () => pending.resolve(queue(2)));
  hook.event(queue(3));
  expect(hook.result.current.controlQueue?.revision).toBe(5);
  const late = deferred<ControlQueueSnapshot>();
  vi.mocked(ApiClient.prototype.getControlQueue).mockReturnValueOnce(late.promise);
  act(() => hook.result.current.refreshControlQueue());
  hook.rerender({ ...hook.options, activeSessionId: "s2", navigationGeneration: 1 });
  await waitFor(() => expect(hook.result.current.controlQueue?.revision).toBe(0));
  await act(async () => late.resolve(queue(99)));
  expect(hook.result.current.controlQueue?.revision).toBe(0);
  hook.rerender({ ...hook.options, navigationGeneration: 2 });
  await waitFor(() => expect(hook.result.current.controlQueueLoading).toBe(false));
  expect(hook.result.current.controlQueue?.revision).toBe(5);
});

it("guards overlapping refresh requests including navigation away and back to the same session", async () => {
  const first = deferred<ControlQueueSnapshot>();
  const second = deferred<ControlQueueSnapshot>();
  vi.mocked(ApiClient.prototype.getControlQueue).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const hook = setup();
  act(() => hook.result.current.refreshControlQueue());
  await act(async () => second.resolve(queue(6)));
  await act(async () => first.resolve(queue(9)));
  expect(hook.result.current.controlQueue?.revision).toBe(6);
});

it("keeps local pending out of the queue and retains a dequeued steering lock until exact consumption", async () => {
  const pending = deferred<void>();
  vi.mocked(ApiClient.prototype.steer).mockReturnValue(pending.promise);
  const hook = setup();
  await waitFor(() => expect(hook.result.current.controlQueueLoading).toBe(false));
  act(() => { hook.result.current.steer("original"); hook.result.current.steer("original"); });
  expect(ApiClient.prototype.steer).toHaveBeenCalledOnce();
  expect(hook.result.current.controlQueue?.items).toEqual([]);
  const control = hook.result.current.pendingControls[0]!;
  hook.event(queue(1, control.id, "steer", control.acknowledgementId));
  expect(hook.result.current.pendingControls).toEqual([]);
  hook.event({ ...empty, revision: 2 });
  act(() => hook.result.current.steer("original"));
  expect(ApiClient.prototype.steer).toHaveBeenCalledOnce();
  expect(hook.draft().text).toBe("original");
  await act(async () => pending.reject(new ApiError(400, "late rejection")));
  expect(hook.result.current.pendingControls).toEqual([]);
  act(() => hook.result.current.applyControlEvent("s1", hook.stores.get("s1")!, { type: "steering_consumed", controlId: control.id, requestId: "r1", acknowledgementId: "wrong", message: { sourceId: "wrong", text: "original" } }));
  expect(hook.draft().text).toBe("original");
  act(() => hook.result.current.applyControlEvent("s1", hook.stores.get("s1")!, { type: "steering_consumed", controlId: control.id, requestId: "r1", acknowledgementId: control.acknowledgementId, message: { sourceId: "right", text: "original" } }));
  expect(hook.draft().text).toBe("");
});

it.each(["HTTP", "queue"] as const)("clears followUp only at %s admission without late reply reviving a confirmed notice", async via => {
  const pending = deferred<void>();
  vi.mocked(ApiClient.prototype.followUp).mockReturnValue(pending.promise);
  const hook = setup();
  act(() => { hook.result.current.followUp("original"); hook.result.current.followUp("original"); });
  expect(ApiClient.prototype.followUp).toHaveBeenCalledOnce();
  const control = hook.result.current.pendingControls[0]!;
  expect(ApiClient.prototype.followUp).toHaveBeenCalledWith("s1", "original", expect.objectContaining({ controlId: control.id, requestId: "r1", acknowledgementId: control.acknowledgementId }));
  expect(hook.draft().text).toBe("original");
  if (via === "queue") {
    hook.event(queue(3, control.id, "followUp", control.acknowledgementId));
    await act(async () => pending.reject(new Error("late network failure")));
    expect(hook.result.current.pendingControls).toEqual([]);
  } else await act(async () => pending.resolve());
  expect(hook.draft().text).toBe("");
});

it.each(["HTTP", "queue"] as const)("sends complete followUp image payload and clears only its admitted snapshot via %s, never again on promoted consumption", async via => {
  const pending = deferred<void>();
  vi.mocked(ApiClient.prototype.followUp).mockReturnValue(pending.promise);
  const hook = setup(); hook.image();
  act(() => hook.result.current.followUp("original"));
  const control = hook.result.current.pendingControls[0]!;
  expect(ApiClient.prototype.followUp).toHaveBeenCalledWith("s1", "original", {
    controlId: control.id, acknowledgementId: control.acknowledgementId, requestId: "r1",
    images: [{ mediaType: "image/png", base64: "AA==" }],
  });
  hook.edit("new draft"); hook.image("new-image");
  if (via === "HTTP") await act(async () => pending.resolve());
  else hook.event(queue(1, control.id, "followUp", control.acknowledgementId));
  expect(hook.draft().text).toBe("new draft");
  expect(hook.draft().attachments.map(item => item.localId)).toEqual(["new-image"]);
  hook.event(queue(2, control.id, "steer", control.acknowledgementId));
  act(() => hook.result.current.applyControlEvent("s1", hook.stores.get("s1")!, { type: "steering_consumed", controlId: control.id, requestId: "r1", acknowledgementId: control.acknowledgementId, message: { sourceId: "promoted", text: "original" } }));
  await act(async () => pending.resolve());
  expect(hook.draft().text).toBe("new draft");
  expect(hook.draft().attachments.map(item => item.localId)).toEqual(["new-image"]);
  expect(hook.options.updateUnsent).toHaveBeenCalledOnce(); // Promotion/consumption must not clear twice.
  expect(ApiClient.prototype.followUp).toHaveBeenCalledOnce();
  expect(ApiClient.prototype.steer).not.toHaveBeenCalled();
});

it("preserves edited followUp text even if changed back before admission", async () => {
  const pending = deferred<void>();
  vi.mocked(ApiClient.prototype.followUp).mockReturnValue(pending.promise);
  const hook = setup();
  act(() => hook.result.current.followUp("original"));
  hook.edit("new"); hook.edit("original");
  await act(async () => pending.resolve());
  expect(hook.draft().text).toBe("original");
});

it.each(["failed", "unknown"] as const)("preserves image and original text on %s followUp, with no automatic resend", async status => {
  vi.mocked(ApiClient.prototype.followUp).mockRejectedValue(status === "failed" ? new ApiError(400, "invalid image") : new Error("network"));
  const hook = setup(); hook.image();
  const draft = hook.draft();
  act(() => hook.result.current.followUp("original"));
  await waitFor(() => expect(hook.result.current.pendingControls[0]?.status).toBe(status));
  expect(ApiClient.prototype.followUp).toHaveBeenCalledWith("s1", "original", expect.objectContaining({ images: [{ mediaType: "image/png", base64: "AA==" }] }));
  expect(hook.draft()).toBe(draft);
  expect(hook.result.current.controlQueue?.items).toEqual([]);
  expect(ApiClient.prototype.followUp).toHaveBeenCalledOnce();
  if (status === "unknown") {
    act(() => hook.result.current.followUp("original"));
    expect(ApiClient.prototype.followUp).toHaveBeenCalledOnce();
  }
});

it.each([{ canWrite: false }, { historyLoading: true }])("enforces handler gates %j for submission and mutation", async gate => {
  const hook = setup(); hook.event(queue(1));
  hook.rerender({ ...hook.options, ...gate });
  act(() => { hook.result.current.steer("original"); hook.result.current.followUp("original"); hook.result.current.deleteControl("remote"); hook.result.current.promoteControl("remote"); });
  expect(ApiClient.prototype.steer).not.toHaveBeenCalled(); expect(ApiClient.prototype.followUp).not.toHaveBeenCalled();
  expect(ApiClient.prototype.deleteControl).not.toHaveBeenCalled(); expect(ApiClient.prototype.promoteControl).not.toHaveBeenCalled();
});

it.each(["queued", "completed"] as const)("does not submit controls when primary request is %s", phase => {
  const hook = setup();
  hook.stores.get("s1")!.applyEvent({ type: phase, requestId: "r1" });
  act(() => { hook.result.current.steer("original"); hook.result.current.followUp("original"); });
  expect(ApiClient.prototype.steer).not.toHaveBeenCalled(); expect(ApiClient.prototype.followUp).not.toHaveBeenCalled();
});

it("deletes with resident identity, releases only its dedup lock and never clears the draft", async () => {
  const hook = setup();
  act(() => hook.result.current.steer("original"));
  await waitFor(() => expect(hook.result.current.pendingControls[0]?.status).toBe("submitted"));
  const control = hook.result.current.pendingControls[0]!;
  hook.event(queue(1, control.id, "steer", control.acknowledgementId));
  act(() => { hook.result.current.deleteControl(control.id); hook.result.current.deleteControl(control.id); });
  await waitFor(() => expect(hook.result.current.controlQueue?.items).toEqual([]));
  expect(ApiClient.prototype.deleteControl).toHaveBeenCalledOnce();
  expect(ApiClient.prototype.deleteControl).toHaveBeenCalledWith("s1", control.id, { requestId: "r1", acknowledgementId: control.acknowledgementId });
  expect(hook.draft().text).toBe("original");
  act(() => hook.result.current.steer("original"));
  expect(ApiClient.prototype.steer).toHaveBeenCalledTimes(2);
});

it("keeps a pending mutation resident and cannot let its stale response overwrite newer SSE", async () => {
  const pending = deferred<ControlQueueSnapshot>();
  vi.mocked(ApiClient.prototype.deleteControl).mockReturnValueOnce(pending.promise);
  const hook = setup(); hook.event(queue(1));
  act(() => hook.result.current.deleteControl("remote"));
  expect(hook.result.current.controlQueue?.items).toHaveLength(1);
  expect(hook.result.current.controlQueueOperations.remote?.status).toBe("pending");
  hook.event(queue(5, "newer"));
  await act(async () => pending.resolve({ ...empty, revision: 2 }));
  expect(hook.result.current.controlQueue?.items[0]?.id).toBe("newer");
  expect(hook.result.current.controlQueue?.revision).toBe(5);
});

it("isolates late mutation replies from another selection and a new navigation generation", async () => {
  const pending = deferred<ControlQueueSnapshot>();
  vi.mocked(ApiClient.prototype.promoteControl).mockReturnValueOnce(pending.promise);
  const hook = setup(); hook.event(queue(1));
  act(() => hook.result.current.promoteControl("remote"));
  hook.rerender({ ...hook.options, activeSessionId: "s2", navigationGeneration: 1 });
  await waitFor(() => expect(hook.result.current.controlQueueLoading).toBe(false));
  hook.rerender({ ...hook.options, navigationGeneration: 2 });
  await waitFor(() => expect(hook.result.current.controlQueueLoading).toBe(false));
  await act(async () => pending.resolve(queue(20, "remote", "steer")));
  expect(hook.result.current.controlQueue?.revision).toBe(1);
  expect(hook.result.current.controlQueue?.items[0]?.kind).toBe("followUp");
});

it("network-unknown deletion never removes the resident row or retries automatically", async () => {
  vi.mocked(ApiClient.prototype.deleteControl).mockRejectedValueOnce(new Error("network"));
  const hook = setup(); hook.event(queue(1));
  act(() => hook.result.current.deleteControl("remote"));
  await waitFor(() => expect(hook.result.current.controlQueueOperations.remote?.status).toBe("unknown"));
  expect(hook.result.current.controlQueue?.items).toHaveLength(1);
  act(() => hook.result.current.deleteControl("remote"));
  expect(ApiClient.prototype.deleteControl).toHaveBeenCalledOnce();
  expect(hook.draft().text).toBe("original");
});

it("promotion updates kind without a new submission or clearing draft", async () => {
  const hook = setup(); hook.event(queue(1));
  act(() => hook.result.current.promoteControl("remote"));
  await waitFor(() => expect(hook.result.current.controlQueue?.items[0]?.kind).toBe("steer"));
  expect(hook.draft().text).toBe("original");
  expect(ApiClient.prototype.steer).not.toHaveBeenCalled(); expect(ApiClient.prototype.followUp).not.toHaveBeenCalled();
  expect(ApiClient.prototype.promoteControl).toHaveBeenCalledWith("s1", "remote", { requestId: "r1", acknowledgementId: "ack" });
});

it("refreshes on drained conflict, retaining busy/error until authoritative removal", async () => {
  const refresh = deferred<ControlQueueSnapshot>();
  const hook = setup();
  await waitFor(() => expect(hook.result.current.controlQueueLoading).toBe(false));
  hook.event(queue(1));
  vi.mocked(ApiClient.prototype.getControlQueue).mockReturnValueOnce(refresh.promise);
  vi.mocked(ApiClient.prototype.deleteControl).mockRejectedValue(new ApiError(409, "drained"));
  act(() => hook.result.current.deleteControl("remote"));
  await waitFor(() => expect(hook.result.current.controlQueueOperations.remote?.status).toBe("failed"));
  expect(hook.result.current.controlQueue?.items).toHaveLength(1);
  await act(async () => refresh.resolve({ ...empty, revision: 2 }));
  expect(hook.result.current.controlQueue?.items).toEqual([]);
  expect(hook.result.current.controlQueueOperations).toEqual({});
});

it("keeps unknown mutation resident and blocks retries; explicit GET can resolve promotion", async () => {
  vi.mocked(ApiClient.prototype.promoteControl).mockRejectedValue(new Error("network"));
  const hook = setup(); hook.event(queue(1));
  act(() => hook.result.current.promoteControl("remote"));
  await waitFor(() => expect(hook.result.current.controlQueueOperations.remote?.status).toBe("unknown"));
  expect(hook.result.current.controlQueue?.items[0]?.kind).toBe("followUp");
  act(() => { hook.result.current.promoteControl("remote"); hook.result.current.deleteControl("remote"); });
  expect(ApiClient.prototype.promoteControl).toHaveBeenCalledOnce(); expect(ApiClient.prototype.deleteControl).not.toHaveBeenCalled();
  vi.mocked(ApiClient.prototype.getControlQueue).mockResolvedValueOnce(queue(2, "remote", "steer"));
  act(() => hook.result.current.refreshControlQueue());
  await waitFor(() => expect(hook.result.current.controlQueueOperations).toEqual({}));
  expect(hook.result.current.controlQueue?.items[0]?.kind).toBe("steer");
});


it.each([
  ["steer", "completed"], ["steer", "aborted"], ["followUp", "completed"], ["followUp", "aborted"],
] as const)("releases unknown %s locks on matching %s without consuming the preserved draft", async (kind, terminal) => {
  vi.mocked(ApiClient.prototype[kind]).mockRejectedValueOnce(new Error("network"));
  const hook = setup(); hook.image();
  act(() => hook.result.current[kind]("original"));
  await waitFor(() => expect(hook.result.current.pendingControls[0]?.status).toBe("unknown"));
  const old = hook.result.current.pendingControls[0]!;
  act(() => hook.result.current.applyControlEvent("s1", hook.stores.get("s1")!, { type: "completed", requestId: "foreign" }));
  expect(hook.result.current.pendingControls[0]?.blocking).not.toBe(false);
  act(() => hook.result.current.applyControlEvent("s2", hook.stores.get("s2")!, { type: terminal, requestId: "r1" }));
  expect(hook.result.current.pendingControls[0]?.blocking).not.toBe(false);
  act(() => hook.result.current.applyControlEvent("s1", hook.stores.get("s1")!, { type: terminal, requestId: "r1" }));
  expect(hook.result.current.pendingControls[0]).toMatchObject({ id: old.id, status: "unknown", blocking: false });
  expect(hook.result.current.pendingControls[0]?.error).toContain("不会自动重发");
  expect(hook.draft().text).toBe("original"); expect(hook.draft().attachments).toHaveLength(1);
  expect(ApiClient.prototype[kind]).toHaveBeenCalledOnce();
  hook.stores.get("s1")!.applyEvent({ type: "completed", requestId: "r1" });
  hook.stores.get("s1")!.applyEvent({ type: "status", phase: "agent_start", requestId: "r2" });
  const next = deferred<void>();
  vi.mocked(ApiClient.prototype[kind]).mockReturnValueOnce(next.promise);
  act(() => hook.result.current[kind]("original"));
  expect(ApiClient.prototype[kind]).toHaveBeenCalledTimes(2);
  expect(hook.result.current.pendingControls[1]).toMatchObject({ requestId: "r2", status: "submitting" });
});

it("resets revision authority for the same session on server generation change and isolates late HTTP", async () => {
  const hook = setup();
  await waitFor(() => expect(hook.result.current.controlQueueLoading).toBe(false));
  hook.event(queue(20));
  const oldGet = deferred<ControlQueueSnapshot>(); const oldMutation = deferred<ControlQueueSnapshot>();
  const oldSubmit = deferred<void>();
  vi.mocked(ApiClient.prototype.getControlQueue).mockReturnValueOnce(oldGet.promise).mockResolvedValue(empty);
  vi.mocked(ApiClient.prototype.promoteControl).mockReturnValueOnce(oldMutation.promise);
  vi.mocked(ApiClient.prototype.followUp).mockReturnValueOnce(oldSubmit.promise);
  act(() => { hook.result.current.refreshControlQueue(); hook.result.current.promoteControl("remote"); hook.result.current.followUp("original"); });
  act(() => hook.result.current.resetControlQueueAuthority());
  await waitFor(() => expect(hook.result.current.controlQueue?.revision).toBe(0));
  await act(async () => { oldGet.resolve(queue(99)); oldMutation.resolve(queue(100, "remote", "steer")); oldSubmit.resolve(); });
  expect(hook.result.current.controlQueue?.revision).toBe(0);
  expect(hook.result.current.controlQueueOperations).toEqual({});
  expect(hook.result.current.pendingControls[0]).toMatchObject({ status: "unknown", blocking: false });
  expect(hook.draft().text).toBe("original");
  hook.event(queue(2)); hook.event(queue(1));
  expect(hook.result.current.controlQueue?.revision).toBe(2);
});
