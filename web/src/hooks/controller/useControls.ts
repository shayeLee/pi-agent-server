import { useRef, useState } from "react";
import { ApiError } from "pi-agent-server/client";
import type { ApiClient, SseEvent } from "pi-agent-server/client";
import type { SubmitSnapshot } from "../../attachment-state.js";
import type { ChatStores } from "./useChatStores.js";
import type { Drafts } from "./useDrafts.js";
import type { Selection } from "./useSelection.js";

export type PendingControl = {
  id: string; kind: "steer" | "followUp"; text: string; requestId?: string; acknowledgementId?: string; snapshot?: SubmitSnapshot; status: "submitting" | "submitted" | "unknown" | "failed";
};

type ControlSnapshot = { sessionId: string; requestId: string; acknowledgementId: string; textRevision: number; snapshot: SubmitSnapshot };

/**
 * Steer / follow-up controls for a running session. A steer's draft input is cleared only when
 * the stream reports `steering_consumed` with the exact control/request/acknowledgement identity.
 */
export function useControls({ api, selection, chats, drafts, captureSnapshot }: {
  api: ApiClient;
  selection: Selection;
  chats: ChatStores;
  drafts: Drafts;
  captureSnapshot: (scope: string, text: string) => SubmitSnapshot | null;
}) {
  const { activeSessionId } = selection;
  const { getChatStore, reportChatError } = chats;
  const { updateUnsent, draftTextRevisionsRef } = drafts;
  const [pendingControls, setPendingControls] = useState<Record<string, PendingControl[]>>({});
  const controlSnapshotsRef = useRef(new Map<string, ControlSnapshot>());

  function submitControl(kind: "steer" | "followUp", text: string): void {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const id = crypto.randomUUID();
    const scope = `session:${sessionId}`;
    const snapshot = kind === "steer" ? captureSnapshot(scope, text) : null;
    const requestId = getChatStore(sessionId).getState().activeRequestId;
    if (kind === "steer" && (!snapshot || !requestId)) return;
    if (kind === "followUp" && !text.trim()) return;
    if (snapshot?.fileIds.length) { reportChatError(sessionId, new Error("插话暂不支持文件附件；输入已保留")); return; }
    if (snapshot && [...controlSnapshotsRef.current.values()].some(old => old.sessionId === sessionId &&
        old.textRevision === (draftTextRevisionsRef.current.get(scope) ?? 0) && old.snapshot.localIds.join() === snapshot.localIds.join())) return;
    const acknowledgementId = crypto.randomUUID();
    if (snapshot && requestId) controlSnapshotsRef.current.set(id, { sessionId, requestId, acknowledgementId, textRevision: draftTextRevisionsRef.current.get(scope) ?? 0, snapshot });
    const update = (status: "submitting" | "submitted" | "unknown" | "failed") =>
      setPendingControls((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).map((row) =>
        row.id === id ? { ...row, status } : row) }));
    setPendingControls((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []),
      { id, kind, text, ...(snapshot ? { snapshot, requestId: requestId!, acknowledgementId } : {}), status: "submitting" }] }));
    const call = kind === "steer" ? api.steer(sessionId, snapshot!.text, { controlId: id,
      acknowledgementId, requestId: requestId!, images: snapshot!.images }) : api.followUp(sessionId, text);
    void call.then(() => update("submitted"), (error) => {
      const failed = error instanceof ApiError && error.status < 500;
      update(failed ? "failed" : "unknown");
      if (failed) controlSnapshotsRef.current.delete(id);
    });
  }
  function steer(text: string): void { submitControl("steer", text); }
  function followUp(text: string): void { submitControl("followUp", text); }

  /** Handles an owned `steering_consumed` event for `sessionId`. */
  function acknowledgeSteering(sessionId: string, event: Extract<SseEvent, { type: "steering_consumed" }>): void {
    setPendingControls(current => {
      const rows = current[sessionId] ?? [];
      const consumed = rows.find(row => row.kind === "steer" && row.id === event.controlId &&
        row.requestId === event.requestId && row.acknowledgementId === event.acknowledgementId);
      if (!consumed) return current;
      return { ...current, [sessionId]: rows.filter(row => row !== consumed) };
    });
    const snapshot = controlSnapshotsRef.current.get(event.controlId);
    if (snapshot && snapshot.sessionId === sessionId && snapshot.requestId === event.requestId &&
        snapshot.acknowledgementId === event.acknowledgementId) {
      controlSnapshotsRef.current.delete(event.controlId);
      updateUnsent(snapshot.snapshot.scope, current => ({ ...current,
        text: (draftTextRevisionsRef.current.get(snapshot.snapshot.scope) ?? 0) === snapshot.textRevision ? "" : current.text,
        attachments: current.attachments.filter(item => !snapshot.snapshot.localIds.includes(item.localId)),
      }));
    }
  }

  return {
    pendingControls: activeSessionId ? pendingControls[activeSessionId] ?? [] : [],
    steer,
    followUp,
    acknowledgeSteering,
  };
}

export type Controls = ReturnType<typeof useControls>;
