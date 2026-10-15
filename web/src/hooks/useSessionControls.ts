import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ApiError, ownsSseEvent, type ApiClient, type ChatStore, type ControlQueueSnapshot, type SseEvent } from "pi-agent-server/client";
import type { SubmitSnapshot, UnsentMessage } from "../attachment-state.js";

type PendingControl = {
  id: string; kind: "steer" | "followUp"; text: string; requestId: string; acknowledgementId: string;
  status: "submitting" | "submitted" | "unknown" | "failed"; error?: string; blocking?: boolean;
};
type ControlOperation = { kind: "delete" | "promote"; status: "pending" | "unknown" | "failed"; error?: string };
type CapturedControl = {
  sessionId: string; requestId: string; acknowledgementId: string; textRevision: number;
  snapshot: SubmitSnapshot; kind: "steer" | "followUp"; admitted: boolean;
};

/** Queue authority and local submission receipts are deliberately independent of consumption. */
export function useSessionControls({ api, activeSessionId, navigationGeneration, canWrite, historyLoading,
  captureSnapshot, getChatStore, draftTextRevisionsRef, updateUnsent, reportChatError, primarySubmissionBlocked }: {
  api: ApiClient;
  activeSessionId: string | null;
  navigationGeneration: number;
  canWrite: boolean;
  historyLoading: boolean;
  captureSnapshot: (scope: string, text: string) => SubmitSnapshot | null;
  getChatStore: (sessionId: string) => ChatStore;
  draftTextRevisionsRef: RefObject<Map<string, number>>;
  updateUnsent: (scope: string, change: (previous: UnsentMessage) => UnsentMessage) => void;
  reportChatError: (sessionId: string, error: unknown) => void;
  primarySubmissionBlocked: (sessionId: string) => boolean;
}) {
  const [pendingControls, setPendingControls] = useState<Record<string, PendingControl[]>>({});
  const [queues, setQueues] = useState<Record<string, ControlQueueSnapshot>>({});
  const queuesRef = useRef(new Map<string, ControlQueueSnapshot>());
  const [controlQueueLoading, setControlQueueLoading] = useState(false);
  const [controlQueueError, setControlQueueError] = useState<string | null>(null);
  const [operations, setOperations] = useState<Record<string, Record<string, ControlOperation>>>({});
  const operationsRef = useRef(new Map<string, Record<string, ControlOperation>>());
  const controlSnapshotsRef = useRef(new Map<string, CapturedControl>());
  const ownerRef = useRef({ sessionId: activeSessionId, generation: navigationGeneration, canWrite, historyLoading });
  ownerRef.current = { sessionId: activeSessionId, generation: navigationGeneration, canWrite, historyLoading };
  const refreshSeqRef = useRef(0);
  const authorityGenerationRef = useRef(0);

  function resetControlQueueAuthority(): void {
    ++authorityGenerationRef.current;
    ++refreshSeqRef.current;
    queuesRef.current.clear();
    setQueues({});
    operationsRef.current.clear();
    setOperations({});
    controlSnapshotsRef.current.clear();
    setPendingControls(current => Object.fromEntries(Object.entries(current).map(([sessionId, rows]) => [sessionId,
      rows.map(row => row.status === "submitting" || row.status === "unknown"
        ? { ...row, status: "unknown" as const, blocking: false, error: zhCN.errors.controlsAfterRestart }
        : { ...row, blocking: false })])));
    refreshControlQueue();
  }

  function clearCaptured(control: CapturedControl): void {
    updateUnsent(control.snapshot.scope, current => ({ ...current,
      text: (draftTextRevisionsRef.current.get(control.snapshot.scope) ?? 0) === control.textRevision ? "" : current.text,
      attachments: current.attachments.filter(item => !control.snapshot.localIds.includes(item.localId)),
    }));
  }

  function acceptQueue(sessionId: string, snapshot: ControlQueueSnapshot): void {
    // A malformed body (proxy error page, older server) must not blank the chat.
    if (!snapshot || !Array.isArray(snapshot.items) || typeof snapshot.revision !== "number") return;
    const previous = queuesRef.current.get(sessionId);
    if (previous && snapshot.revision < previous.revision) return;
    queuesRef.current.set(sessionId, snapshot);
    setQueues(current => ({ ...current, [sessionId]: snapshot }));
    setControlQueueError(null);
    const confirmed = new Set(snapshot.items.map(item => item.id));
    setPendingControls(current => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter(row => !snapshot.items.some(item =>
      row.id === item.id && row.requestId === snapshot.requestId && row.acknowledgementId === item.acknowledgementId)) }));
    for (const item of snapshot.items) {
      const captured = controlSnapshotsRef.current.get(item.id);
      if (captured?.sessionId !== sessionId || captured.requestId !== snapshot.requestId || captured.acknowledgementId !== item.acknowledgementId) continue;
      if (!captured.admitted && captured.kind === "followUp") clearCaptured(captured);
      captured.admitted = true;
      // Promotion is not consumption: retain the immutable lock and inputs.
    }
    const currentOps = operationsRef.current.get(sessionId) ?? {};
    const nextOps = { ...currentOps };
    for (const [id, operation] of Object.entries(currentOps)) {
      if (operation.status === "pending") continue;
      if (!confirmed.has(id) || (operation.kind === "promote" && snapshot.items.find(item => item.id === id)?.kind === "steer")) delete nextOps[id];
    }
    operationsRef.current.set(sessionId, nextOps);
    setOperations(current => ({ ...current, [sessionId]: nextOps }));
  }

  function refreshControlQueue(): void {
    const owner = ownerRef.current;
    if (!owner.sessionId) return;
    const sessionId = owner.sessionId;
    const seq = ++refreshSeqRef.current;
    const revision = queuesRef.current.get(sessionId)?.revision ?? -1;
    const isCurrent = () => ownerRef.current.sessionId === sessionId && ownerRef.current.generation === owner.generation && refreshSeqRef.current === seq;
    setControlQueueLoading(true);
    setControlQueueError(null);
    void api.getControlQueue(sessionId).then(snapshot => {
      if (isCurrent()) acceptQueue(sessionId, snapshot);
    }, error => {
      if (isCurrent() && (queuesRef.current.get(sessionId)?.revision ?? -1) === revision) setControlQueueError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (isCurrent()) setControlQueueLoading(false); });
  }

  useEffect(() => {
    setControlQueueError(null);
    setControlQueueLoading(false);
    refreshControlQueue();
    return () => { ++refreshSeqRef.current; };
  }, [api, activeSessionId, navigationGeneration]);

  function applyControlEvent(sessionId: string, store: ChatStore, event: SseEvent): void {
    if (event.type === "control_queue") {
      if (ownerRef.current.sessionId === sessionId) acceptQueue(sessionId, { requestId: event.requestId, revision: event.revision, items: event.items });
      return;
    }
    if ((event.type === "aborted" || event.type === "completed" || event.type === "error") && event.requestId) {
      for (const [id, captured] of controlSnapshotsRef.current) {
        if (captured.sessionId === sessionId && captured.requestId === event.requestId) controlSnapshotsRef.current.delete(id);
      }
      setPendingControls(current => ({ ...current, [sessionId]: (current[sessionId] ?? []).flatMap(row => {
        if (row.requestId !== event.requestId) return [row];
        if (row.status === "submitting" || row.status === "unknown") return [{ ...row, status: "unknown" as const, blocking: false,
          error: zhCN.errors.controlsAfterCompletion }];
        return row.kind === "steer" ? [] : [{ ...row, blocking: false }];
      }) }));
    }
    if (event.type === "steering_consumed" && ownsSseEvent(store.getState(), event)) {
      setPendingControls(current => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter(row => !(row.id === event.controlId && row.requestId === event.requestId && row.acknowledgementId === event.acknowledgementId)) }));
      const captured = controlSnapshotsRef.current.get(event.controlId);
      if (captured && captured.sessionId === sessionId && captured.requestId === event.requestId && captured.acknowledgementId === event.acknowledgementId) {
        controlSnapshotsRef.current.delete(event.controlId);
        if (!captured.admitted || captured.kind === "steer") clearCaptured(captured);
      }
    }
  }

  function writable(): boolean {
    const owner = ownerRef.current;
    return !!owner.sessionId && owner.canWrite && !owner.historyLoading;
  }

  function submitControl(kind: "steer" | "followUp", text: string): void {
    if (!writable()) return;
    const sessionId = ownerRef.current.sessionId!;
    // Read the primary owner's synchronous gate, not a potentially stale Composer render.
    // Session creation migrates the draft before the primary HTTP receipt arrives.
    if (primarySubmissionBlocked(sessionId)) return;
    const state = getChatStore(sessionId).getState();
    if (state.phase !== "streaming" || !state.activeRequestId) return;
    const requestId = state.activeRequestId;
    const scope = `session:${sessionId}`;
    const snapshot = captureSnapshot(scope, text);
    if (!snapshot) return;
    if (snapshot.fileIds.length) { reportChatError(sessionId, new Error(zhCN.errors.controlFilesUnsupported)); return; }
    const textRevision = draftTextRevisionsRef.current.get(scope) ?? 0;
    if ([...controlSnapshotsRef.current.values()].some(old => old.sessionId === sessionId && old.textRevision === textRevision &&
      old.snapshot.text === snapshot.text && old.snapshot.localIds.join() === snapshot.localIds.join())) return;
    const id = crypto.randomUUID();
    const acknowledgementId = crypto.randomUUID();
    const captured: CapturedControl = { sessionId, requestId, acknowledgementId, textRevision, snapshot, kind, admitted: false };
    controlSnapshotsRef.current.set(id, captured);
    const update = (status: PendingControl["status"], error?: string) => setPendingControls(current => ({ ...current,
      [sessionId]: (current[sessionId] ?? []).map(row => row.id === id ? { ...row, status, error } : row) }));
    setPendingControls(current => ({ ...current, [sessionId]: [...(current[sessionId] ?? []),
      { id, kind, text: snapshot.text, requestId, acknowledgementId, status: "submitting" }] }));
    const input = { controlId: id, acknowledgementId, requestId, images: snapshot.images };
    const call = kind === "steer" ? api.steer(sessionId, snapshot.text, input) : api.followUp(sessionId, snapshot.text, input);
    void call.then(() => {
      if (controlSnapshotsRef.current.get(id) !== captured || captured.admitted) return;
      captured.admitted = true;
      if (kind === "followUp") clearCaptured(captured);
      update("submitted");
      // Admission is not queue residence. Read the authoritative queue separately.
      if (ownerRef.current.sessionId === sessionId) refreshControlQueue();
    }, error => {
      if (controlSnapshotsRef.current.get(id) !== captured || captured.admitted) return;
      const failed = error instanceof ApiError && error.status < 500 && !error.message.includes("REQUEST_STATUS_UNKNOWN");
      update(failed ? "failed" : "unknown", error instanceof Error ? error.message : String(error));
      if (failed) controlSnapshotsRef.current.delete(id);
    });
  }

  function mutateControl(id: string, kind: ControlOperation["kind"]): void {
    if (!writable()) return;
    const owner = ownerRef.current;
    const sessionId = owner.sessionId!;
    const queue = queuesRef.current.get(sessionId);
    const item = queue?.items.find(row => row.id === id);
    if (!item || !queue?.requestId || (kind === "promote" && item.kind !== "followUp")) return;
    const existing = operationsRef.current.get(sessionId)?.[id];
    if (existing?.status === "pending" || existing?.status === "unknown") return;
    const setOperation = (operation: ControlOperation | null) => {
      const next = { ...operationsRef.current.get(sessionId) };
      if (operation) next[id] = operation;
      else delete next[id];
      operationsRef.current.set(sessionId, next);
      setOperations(current => ({ ...current, [sessionId]: next }));
    };
    setOperation({ kind, status: "pending" });
    const identity = { requestId: queue.requestId, acknowledgementId: item.acknowledgementId };
    const call = kind === "delete" ? api.deleteControl(sessionId, id, identity) : api.promoteControl(sessionId, id, identity);
    const authorityGeneration = authorityGenerationRef.current;
    const isCurrent = () => ownerRef.current.sessionId === sessionId && ownerRef.current.generation === owner.generation && authorityGenerationRef.current === authorityGeneration;
    void call.then(snapshot => {
      if (authorityGenerationRef.current !== authorityGeneration) return;
      if (kind === "delete") {
        controlSnapshotsRef.current.delete(id); // Release only dedup ownership; never clear the draft.
        setPendingControls(current => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter(row => row.id !== id) }));
      }
      setOperation(null);
      if (isCurrent()) acceptQueue(sessionId, snapshot);
    }, error => {
      if (authorityGenerationRef.current !== authorityGeneration) return;
      const failed = error instanceof ApiError && error.status < 500;
      setOperation({ kind, status: failed ? "failed" : "unknown", error: error instanceof Error ? error.message : String(error) });
      if (error instanceof ApiError && error.status === 409 && isCurrent()) refreshControlQueue();
    });
  }

  return {
    pendingControls: activeSessionId ? pendingControls[activeSessionId] ?? [] : [],
    controlQueue: activeSessionId ? queues[activeSessionId] ?? null : null,
    controlQueueLoading, controlQueueError,
    controlQueueOperations: activeSessionId ? operations[activeSessionId] ?? {} : {},
    resetControlQueueAuthority, refreshControlQueue, deleteControl: (id: string) => mutateControl(id, "delete"),
    promoteControl: (id: string) => mutateControl(id, "promote"),
    steer: (text: string) => submitControl("steer", text), followUp: (text: string) => submitControl("followUp", text), applyControlEvent,
  };
}
