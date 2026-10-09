import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, createSseConnection, firstUserPrompt, ownsSseEvent } from "pi-agent-server/client";
import type { ApiClient, SseEvent, UsageSnapshot } from "pi-agent-server/client";
import type { EventLogEntry } from "../../types.js";
import { readMessageImages } from "../../message-images.js";
import { clearRecentSelection } from "../../recent-selection.js";
import { projectExportTimeline } from "./export-timeline.js";
import type { ChatStores } from "./useChatStores.js";
import type { Controls } from "./useControls.js";
import type { Selection } from "./useSelection.js";
import type { SessionList } from "./useSessionList.js";
import type { Submission } from "./useSubmission.js";
import type { Usage } from "./useUsage.js";

/**
 * Active session stream: restores the export baseline once, then follows SSE from the consumed
 * cursor and routes owned events to submission receipts, usage and steering acknowledgements.
 */
export function useSessionStream({ api, selection, chats, usage, sessionList, submission, controls }: {
  api: ApiClient;
  selection: Selection;
  chats: ChatStores;
  usage: Usage;
  sessionList: SessionList;
  submission: Submission;
  controls: Controls;
}) {
  const { activeSessionId, setActiveSessionId } = selection;
  const { chatStoresRef, emptyChatStore, eventCursorsRef, newlyCreatedIdsRef, historyReadySessionIdsRef } = chats;
  const { emptyHistoryIdsRef, rememberFirstPrompt } = sessionList;
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const eventSeqRef = useRef(0);

  const chatStore =
    activeSessionId === null
      ? emptyChatStore
      : (chatStoresRef.current.get(activeSessionId) ?? emptyChatStore);
  const subscribeChat = useCallback(
    (listener: () => void) => chatStore.subscribe(() => listener()),
    [chatStore],
  );
  const getChatSnapshot = useCallback(() => chatStore.getState(), [chatStore]);
  const rawChatState = useSyncExternalStore(subscribeChat, getChatSnapshot, getChatSnapshot);

  function logEvent(event: SseEvent): void {
    eventSeqRef.current += 1;
    const seq = eventSeqRef.current;
    const { type, ...data } = event;
    setEventLog((prev) => [
      ...prev,
      {
        seq,
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        type,
        data,
      },
    ]);
  }

  useEffect(() => {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    const store = chatStore;
    const freshSession = newlyCreatedIdsRef.current.has(sessionId);
    const restoreOnLoad = !freshSession && !historyReadySessionIdsRef.current.has(sessionId);
    const stateAtLoadStart = store.getState();
    const usageRevision = usage.usageRevision(sessionId);
    setEventLog([]);
    setHistoryNotice(null);
    let cancelled = false;
    let connection: { close: () => void } | null = null;

    void (async () => {
      let cursor = eventCursorsRef.current.get(sessionId) ?? 0;
      try {
        // A just-created session has no earlier history. Start from cursor 0 so events
        // emitted before React subscribes are replayed, rather than skipped by an export cursor.
        if (!freshSession) {
        const data = (await api.exportSession(sessionId)) as {
          messages?: unknown;
          timeline?: unknown;
          lastEventId?: number;
          usageSnapshot?: UsageSnapshot;
        };
        if (cancelled) return;
        const messages = data?.messages ?? data;
        const legacyHistory = (Array.isArray(messages) ? messages : [])
          .filter(
            (message): message is { role: string; text: string; images?: unknown; sourceId?: string } =>
              typeof message === "object" &&
              message !== null &&
              typeof (message as { text?: unknown }).text === "string",
          )
          .map((message, index) => ({
            kind: "message" as const,
            id: message.role === "user" && typeof message.sourceId === "string" ? `history-message:${message.sourceId}` : `hist-${index}`,
            role: (message.role === "user" ? "user" : "assistant") as "user" | "assistant",
            text: message.text,
            ...(message.role === "user" ? { images: readMessageImages(message.images) } : {}),
            streaming: false,
          }));
        if (Array.isArray(messages)) {
          rememberFirstPrompt(sessionId, firstUserPrompt(messages));
          if (messages.length === 0 && (!Array.isArray(data?.timeline) || data.timeline.length === 0)) emptyHistoryIdsRef.current.add(sessionId);
        }
        const rawTimeline = data?.timeline;
        const history = Array.isArray(rawTimeline) && rawTimeline.length
          ? projectExportTimeline(rawTimeline, Array.isArray(messages) ? messages : []) : legacyHistory;
        const untouchedUsage = store.getState() === stateAtLoadStart;
        // Restore only the first baseline, and only if the store stayed untouched while loading.
        // Returning to a session must preserve its SSE stream and optimistic sends.
        if (
          restoreOnLoad &&
          store.getState() === stateAtLoadStart &&
          history.length > 0
        ) {
          store.restoreHistory(history);
        }
        if (untouchedUsage) {
          if (usageRevision === usage.usageRevision(sessionId)) {
            store.restoreExecution(data.usageSnapshot?.execution);
            usage.restoreExportedUsage(sessionId, data.usageSnapshot);
          }
        }
        // Only the initial export baseline may skip events already represented by history.
        // Returning sessions keep their cached timeline and replay all missed lifecycle/data.
        if (!eventCursorsRef.current.has(sessionId) && untouchedUsage && typeof data?.lastEventId === "number") cursor = data.lastEventId;
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          clearRecentSelection();
          setActiveSessionId(null);
          return;
        }
        // Transient export failure must not erase the remembered position.
      }
      if (cancelled) return;
      chats.markHistoryReady(sessionId);

      eventCursorsRef.current.set(sessionId, cursor);
      connection = createSseConnection({
        url: `/v1/sessions/${sessionId}/events`,
        lastEventId: cursor,
        onOpen: () => {
          if (!cancelled) setConnected(true);
        },
        onError: () => {
          store.clearModelOutput();
          if (!cancelled) setConnected(false);
        },
        onDisconnect: () => {
          store.clearModelOutput();
          if (!cancelled) setConnected(false);
        },
        onNoLiveStream: () => {
          store.clearModelOutput();
          if (!cancelled) setConnected(false);
        },
        onEvent: (event, lastEventId) => {
          if (cancelled) return;
          if (Number.isFinite(lastEventId)) eventCursorsRef.current.set(sessionId, lastEventId);
          // Each ownership check reads the store as left by the previous step, before applyEvent.
          if (ownsSseEvent(store.getState(), event) && (event.type === "queued" || event.type === "status") && event.requestId) {
            submission.acknowledgeRequestEvent(store, sessionId, event.requestId);
          }
          if (ownsSseEvent(store.getState(), event) && (event.type === "usage" || (event.type === "status" && event.phase === "agent_start"))) {
            usage.supersedeSnapshot(sessionId, event.type === "usage");
          }
          if (event.type === "steering_consumed" && ownsSseEvent(store.getState(), event)) {
            controls.acknowledgeSteering(sessionId, event);
          }
          logEvent(event);
          store.applyEvent(event);
        },
      });
      newlyCreatedIdsRef.current.delete(sessionId);
    })();

    return () => {
      cancelled = true;
      connection?.close();
      store.clearModelOutput();
      setConnected(false);
    };
  }, [api, activeSessionId, chatStore]);

  function clearEventLog(): void {
    setEventLog([]);
  }

  return { rawChatState, eventLog, connected, historyNotice, clearEventLog };
}
