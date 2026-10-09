import { useRef, useState } from "react";
import { ApiError } from "pi-agent-server/client";
import type { ApiClient, ChatStore, Project } from "pi-agent-server/client";
import { EMPTY_MESSAGE, type SubmissionState, type SubmitOutcome, type SubmitSnapshot } from "../../attachment-state.js";
import type { ChatStores } from "./useChatStores.js";
import type { Drafts } from "./useDrafts.js";
import type { Selection } from "./useSelection.js";
import type { SessionList } from "./useSessionList.js";

/**
 * Immutable-snapshot message submission: create session -> apply config -> send.
 * Outcomes are accepted / failed / unknown; an unknown result is never resent automatically,
 * only confirmed by a matching SSE receipt or an explicit user action.
 */
export function useSubmission({ api, selection, chats, sessionList, draftProjectsRef, projectAllowsCreation, drafts, setLoadError }: {
  api: ApiClient;
  selection: Selection;
  chats: ChatStores;
  sessionList: SessionList;
  draftProjectsRef: { current: Map<string, Project> };
  projectAllowsCreation: boolean;
  drafts: Drafts;
  setLoadError: (value: string | null) => void;
}) {
  const {
    activeSessionId, setActiveSessionId, activeProjectId, activeProjectIdRef,
    navigationGenerationRef, currentScope, rememberSelection,
  } = selection;
  const { getChatStore, newlyCreatedIdsRef, historyReadySessionIdsRef } = chats;
  const { sessions, setSessions, emptyHistoryIdsRef, mergeTitleMetadata, rememberAcceptedPrompt } = sessionList;
  const { draftStore, updateUnsent } = drafts;
  const [submitStates, setSubmitStates] = useState<Record<string, SubmissionState>>({});
  const submitStatesRef = useRef<typeof submitStates>({});
  const submittingScopesRef = useRef(new Set<string>());
  const imageInsertionRef = useRef(new Map<string, number>());
  // Receipts live only as long as their HTTP send, independently of navigation/cursors.
  // A pending promise already owns this receipt; no historical confirmation cache is needed.
  const inflightReceiptsRef = useRef(new Map<string, { sessionId: string; accepted: boolean }>());
  const submitState = submitStates[currentScope] ?? null;

  function updateSubmitState(scope: string, value: SubmissionState | null): void {
    const next = { ...submitStatesRef.current };
    if (value) next[scope] = value;
    else delete next[scope];
    submitStatesRef.current = next;
    setSubmitStates(next);
  }

  function projectAcceptedImages(store: ChatStore, snapshot: SubmitSnapshot): void {
    const current = store.getState().timeline;
    const id = `confirmed-${snapshot.requestId}`;
    if (current.some((item) => item.id === id)) return;
    const index = imageInsertionRef.current.get(snapshot.requestId) ?? current.length;
    store.restoreHistory([...current.slice(0, index), { kind: "message", id, role: "user",
      text: snapshot.text || (snapshot.fileIds.length ? `附件（${snapshot.fileIds.length} 个）` : ""),
      images: snapshot.images, streaming: false }, ...current.slice(index)]);
    imageInsertionRef.current.delete(snapshot.requestId);
  }

  /** Enter a page-local start state; this action never calls the session creation API. */
  function createSession(): void {
    if (activeProjectId === null || sessions === null || !projectAllowsCreation) return;
    rememberSelection(activeProjectId, null);
    setActiveSessionId(null);
    setLoadError(null);
  }

  async function createSessionWithMessage(text: string): Promise<boolean> {
    return (await submitCurrentMessage(text)) === "accepted";
  }

  function captureSnapshot(scope: string, text: string): SubmitSnapshot | null {
    const draft = draftStore.getSnapshot(scope);
    const attachments = draft.attachments;
    if (attachments.some((item) => item.status !== "ready")) return null;
    const fileIds = attachments.flatMap((item) => item.server ? [item.server.fileId] : []);
    const images = attachments.flatMap((item) => item.image ? [{ mediaType: item.image.mediaType, base64: item.image.base64 }] : []);
    if (!text.trim() && !fileIds.length && !images.length) return null;
    const session = activeSessionId ? sessions?.find((row) => row.id === activeSessionId) : null;
    const projectId = session?.projectId ?? activeProjectId;
    if (!projectId) return null;
    return { scope, projectId, sessionId: session?.id ?? null, requestId: crypto.randomUUID(),
      createRequestId: crypto.randomUUID(), text: text.trim(), localIds: attachments.map((item) => item.localId),
      fileIds: [...fileIds], images: images.map((image) => ({ ...image })), settings: { ...draft.settings } };
  }

  function knownRejection(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false;
    if (error.status === 409 && error.message.includes("REQUEST_STATUS_UNKNOWN")) return false;
    return error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404 ||
      error.status === 413 || error.status === 415 || error.status === 429 || error.status === 507 ||
      (error.status === 409 && !error.message.includes("REQUEST_STATUS_UNKNOWN"));
  }

  function clearSubmittedInputs(scope: string, snapshot: SubmitSnapshot): void {
    updateUnsent(scope, (current) => ({ ...current,
      text: current.text.trim() === snapshot.text ? "" : current.text,
      attachments: current.attachments.filter((item) => !snapshot.localIds.includes(item.localId)),
    }));
  }

  async function runSnapshot(initialScope: string, original: SubmitSnapshot, resumeAt: "create" | "config" | "send" = "create"): Promise<SubmitOutcome> {
    const navigationGeneration = navigationGenerationRef.current;
    let scope = initialScope;
    let snapshot = original;
    let stage: "create" | "config" | "send" = snapshot.sessionId ? (resumeAt === "create" ? "send" : resumeAt) : "create";
    let messageId: string | null = null;
    let receipt: { sessionId: string; accepted: boolean } | undefined;
    const update = (phase: SubmissionState["phase"], error?: string) =>
      updateSubmitState(scope, { snapshot, phase, stage, ...(error ? { error } : {}) });
    try {
      if (!snapshot.sessionId) {
        stage = "create";
        update("creating");
        const created = await api.createSession(undefined, snapshot.projectId, snapshot.createRequestId);
        snapshot = { ...snapshot, sessionId: created.id };
        const sessionScope = `session:${created.id}`;
        draftProjectsRef.current.delete(created.projectId);
        newlyCreatedIdsRef.current.add(created.id);
        emptyHistoryIdsRef.current.add(created.id);
        getChatStore(created.id);
        // The editor moves to the real session without losing input or the immutable submission.
        const from = draftStore.getSnapshot(initialScope);
        const sessionDraft = draftStore.getAll()[sessionScope];
        const selectionUnchanged = navigationGeneration === navigationGenerationRef.current &&
          activeProjectIdRef.current === snapshot.projectId;
        // Move edited inputs too, never a navigated-away owner or an occupied target.
        // snapshot.scope tracks input ownership, separately from the receiving session.
        if (selectionUnchanged && (sessionDraft === undefined || sessionDraft === EMPTY_MESSAGE)) {
          updateUnsent(sessionScope, () => ({ ...from }));
          updateUnsent(initialScope, () => EMPTY_MESSAGE);
          snapshot = { ...snapshot, scope: sessionScope };
          updateSubmitState(initialScope, null);
          scope = sessionScope;
          submittingScopesRef.current.add(scope);
        }
        setSessions((previous) => activeProjectIdRef.current === snapshot.projectId && !previous?.some((row) => row.id === created.id)
          ? [...(previous ?? []), created] : previous);
        if (selectionUnchanged) {
          rememberSelection(created.projectId, created.id);
          setActiveSessionId(created.id);
        }
      }
      if (resumeAt !== "send" && Object.keys(snapshot.settings).length) {
        stage = "config";
        update("configuring");
        const configured = await api.updateSessionConfig(snapshot.sessionId!, snapshot.settings);
        setSessions((previous) => previous?.map((row) => row.id === configured.id ? mergeTitleMetadata(configured, true) : row) ?? null);
      }
      stage = "send";
      update("submitting");
      const store = getChatStore(snapshot.sessionId!);
      messageId = `confirmed-${snapshot.requestId}`;
      const label = snapshot.text || (snapshot.fileIds.length ? `附件（${snapshot.fileIds.length} 个）` : "");
      // Image snapshots are projected only after acceptance, never as a sent-looking optimistic image.
      if (!snapshot.images.length) store.addUserMessage(label, messageId, snapshot.requestId);
      else {
        store.beginRequest(snapshot.requestId);
        imageInsertionRef.current.set(snapshot.requestId, store.getState().timeline.length);
      }
      receipt = { sessionId: snapshot.sessionId!, accepted: false };
      inflightReceiptsRef.current.set(snapshot.requestId, receipt);
      await api.sendMessage(snapshot.sessionId!, { requestId: snapshot.requestId, prompt: snapshot.text,
        ...(snapshot.fileIds.length ? { fileIds: snapshot.fileIds } : {}),
        ...(snapshot.images.length ? { images: snapshot.images } : {}) });
      if (snapshot.images.length) projectAcceptedImages(store, snapshot);
      rememberAcceptedPrompt(snapshot.sessionId!, snapshot.text);
      update("accepted");
      clearSubmittedInputs(snapshot.scope, snapshot);
      return "accepted";
    } catch (error) {
      if (stage === "send" && messageId && !snapshot.images.length && !receipt?.accepted) {
        getChatStore(snapshot.sessionId!).rollbackUserMessage(messageId, "消息提交结果未确认");
      }
      if (stage === "send" && receipt?.accepted) {
        if (snapshot.images.length) projectAcceptedImages(getChatStore(snapshot.sessionId!), snapshot);
        rememberAcceptedPrompt(snapshot.sessionId!, snapshot.text);
        update("accepted");
        clearSubmittedInputs(snapshot.scope, snapshot);
        return "accepted";
      }
      const message = error instanceof Error ? error.message : String(error);
      // A network/5xx result is ambiguous: no automatic retry, no false failure/success.
      const unknown = stage === "send" ? !knownRejection(error) : error instanceof ApiError ? error.status >= 500 : true;
      update(unknown ? "unknown" : "failed", message);
      if (!unknown && snapshot.sessionId && stage === "send") {
        const store = getChatStore(snapshot.sessionId);
        // A failed retry must not close a newer request that claimed the stream meanwhile.
        store.applyEvent({ type: "error", message, requestId: snapshot.requestId });
      }
      return unknown ? "unknown" : "failed";
    } finally {
      if (receipt && inflightReceiptsRef.current.get(snapshot.requestId) === receipt) {
        inflightReceiptsRef.current.delete(snapshot.requestId);
      }
      submittingScopesRef.current.delete(initialScope);
      submittingScopesRef.current.delete(scope);
    }
  }

  async function submitCurrentMessage(text: string): Promise<SubmitOutcome> {
    const scope = currentScope;
    if (!activeSessionId && !projectAllowsCreation) return "failed";
    if (submittingScopesRef.current.has(scope) || submitStatesRef.current[scope]?.phase === "unknown") return "unknown";
    const snapshot = captureSnapshot(scope, text);
    if (!snapshot || (snapshot.sessionId && !historyReadySessionIdsRef.current.has(snapshot.sessionId))) return "failed";
    submittingScopesRef.current.add(scope);
    setLoadError(null);
    return runSnapshot(scope, snapshot, snapshot.sessionId ? "send" : "create");
  }

  async function sendMessage(text: string): Promise<boolean> {
    return (await submitCurrentMessage(text)) === "accepted";
  }

  async function confirmUnknownCreation(): Promise<SubmitOutcome> {
    const scope = currentScope;
    const pending = submitStatesRef.current[scope];
    if (!pending || pending.phase !== "unknown" || pending.stage !== "create" || submittingScopesRef.current.has(scope)) return "unknown";
    // createRequestId is the server's idempotent lookup/creation key; never allocate a new key here.
    submittingScopesRef.current.add(scope);
    return runSnapshot(scope, pending.snapshot, "create");
  }

  async function retryFailedSubmission(): Promise<SubmitOutcome> {
    const scope = currentScope;
    const pending = submitStatesRef.current[scope];
    if (!pending || pending.phase !== "failed" || submittingScopesRef.current.has(scope)) return "failed";
    submittingScopesRef.current.add(scope);
    return runSnapshot(scope, pending.snapshot, pending.stage);
  }

  /**
   * An owned queued/status event for `requestId` is the server's receipt for an in-flight send.
   * It marks the pending HTTP receipt accepted and settles an "unknown" submission as accepted.
   */
  function acknowledgeRequestEvent(store: ChatStore, sessionId: string, requestId: string): void {
    // Input ownership can remain in new:<project> after navigation during creation.
    // Match transport identity, never editor text or the currently selected scope.
    const match = Object.entries(submitStatesRef.current).find(([, pending]) =>
      pending.snapshot.sessionId === sessionId && pending.snapshot.requestId === requestId &&
      pending.stage === "send" && (pending.phase === "submitting" || pending.phase === "unknown"));
    const receipt = inflightReceiptsRef.current.get(requestId);
    if (match && receipt?.sessionId === sessionId) receipt.accepted = true;
    const [scope, pending] = match ?? [];
    if (scope && pending?.phase === "unknown") {
      const confirmed = pending.snapshot;
      projectAcceptedImages(store, confirmed);
      rememberAcceptedPrompt(sessionId, confirmed.text);
      store.setError(null);
      updateSubmitState(scope, { ...pending, phase: "accepted", error: undefined });
      clearSubmittedInputs(confirmed.scope, confirmed);
    }
  }

  return {
    submitState,
    captureSnapshot,
    createSession,
    createSessionWithMessage,
    sendMessage,
    confirmUnknownCreation,
    retryFailedSubmission,
    acknowledgeRequestEvent,
  };
}

export type Submission = ReturnType<typeof useSubmission>;
