import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { ApiError, createSseConnection, firstUserPrompt, type ApiClient, type ChatState, type ChatStore, type SseEvent, type UsageSnapshot } from "pi-agent-server/client";
import { projectExportTimeline, projectLegacyHistory } from "./history-projection.js";

type Setter<T> = Dispatch<SetStateAction<T>>;
type SessionStreamOptions = {
  api: ApiClient;
  activeSessionId: string | null;
  navigationGeneration: number;
  isCurrent: () => boolean;
  chatStore: ChatStore;
  newlyCreatedIdsRef: RefObject<Set<string>>;
  historyReadySessionIdsRef: RefObject<Set<string>>;
  emptyHistoryIdsRef: RefObject<Set<string>>;
  eventCursorsRef: RefObject<Map<string, number>>;
  usageRevisionRef: RefObject<Map<string, number>>;
  setHistoryReadySessionIds: Setter<ReadonlySet<string>>;
  setUsageSnapshots: Setter<Record<string, UsageSnapshot | undefined>>;
  setInvalidContexts: Setter<ReadonlySet<string>>;
  onInvalidSession: (sessionId: string) => void;
  setConnected: Setter<boolean>;
  onLoad: () => void;
  onOpen?: () => void;
  onEpochReset?: () => void;
  rememberFirstPrompt: (sessionId: string, prompt: string | null) => void;
  onEvent: (sessionId: string, store: ChatStore, event: SseEvent) => void;
};

/** Owns export bootstrap, consumed cursors and the selected session's transport lifetime.
 * Callbacks deliberately belong to the subscribing render, just like the original effect;
 * editor renders must not reconnect the stream or replace its ownership snapshot.
 */
export function useSessionStream({
  api, activeSessionId, navigationGeneration, isCurrent, chatStore, newlyCreatedIdsRef, historyReadySessionIdsRef,
  emptyHistoryIdsRef, eventCursorsRef, usageRevisionRef, setHistoryReadySessionIds,
  setUsageSnapshots, setInvalidContexts, onInvalidSession, setConnected,
  onLoad, onOpen, onEpochReset, rememberFirstPrompt, onEvent,
}: SessionStreamOptions): void {
  const serverEpochRef = useRef<string | null>(null);
  useEffect(() => {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    const store = chatStore;
    const freshSession = newlyCreatedIdsRef.current.has(sessionId);
    const restoreOnLoad = !freshSession && !historyReadySessionIdsRef.current.has(sessionId);
    const stateAtLoadStart = store.getState();
    const usageRevision = usageRevisionRef.current.get(sessionId) ?? 0;
    onLoad();
    let cancelled = false;
    const ownsStream = () => !cancelled && isCurrent();
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
            compaction?: ChatState["compaction"];
          };
          if (!ownsStream()) return;
          const messages = data?.messages ?? data;
          const legacyHistory = projectLegacyHistory(messages);
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
            if (usageRevision === (usageRevisionRef.current.get(sessionId) ?? 0)) {
              store.restoreExecution(data.usageSnapshot?.execution);
              setUsageSnapshots(previous => ({ ...previous, [sessionId]: data.usageSnapshot ?? {} }));
              if (data.usageSnapshot) setInvalidContexts(previous => { const next = new Set(previous); next.delete(sessionId); return next; });
            }
          }
          // Only the initial export baseline may skip events already represented by history.
          // Returning sessions keep their cached timeline and replay all missed lifecycle/data.
          if (!eventCursorsRef.current.has(sessionId) && untouchedUsage && typeof data?.lastEventId === "number") {
            store.restoreCompaction(data.compaction);
            cursor = data.lastEventId;
          }
        }
      } catch (error) {
        if (!ownsStream()) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          onInvalidSession(sessionId);
          return;
        }
        // Transient export failure must not erase the remembered position.
      }
      if (!ownsStream()) return;
      historyReadySessionIdsRef.current.add(sessionId);
      setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));

      eventCursorsRef.current.set(sessionId, cursor);
      connection = createSseConnection({
        url: `/v1/sessions/${sessionId}/events`,
        lastEventId: cursor,
        initialEpoch: serverEpochRef.current ?? undefined,
        onOpen: () => {
          if (ownsStream()) {
            setConnected(true);
            onOpen?.();
          }
        },
        onEpoch: epoch => {
          if (!ownsStream() || serverEpochRef.current === epoch) return;
          serverEpochRef.current = epoch;
          eventCursorsRef.current.clear();
          eventCursorsRef.current.set(sessionId, 0);
          onEpochReset?.();
        },
        onError: () => {
          if (!ownsStream()) return;
          store.markDisconnected();
          setConnected(false);
        },
        onDisconnect: () => {
          if (!ownsStream()) return;
          store.markDisconnected();
          setConnected(false);
        },
        onNoLiveStream: () => {
          if (!ownsStream()) return;
          store.markDisconnected();
          setConnected(false);
        },
        onEvent: (event, lastEventId) => {
          if (!ownsStream()) return;
          if (Number.isFinite(lastEventId)) eventCursorsRef.current.set(sessionId, lastEventId);
          onEvent(sessionId, store, event);
        },
      });
      newlyCreatedIdsRef.current.delete(sessionId);
    })();

    return () => {
      cancelled = true;
      connection?.close();
      store.markDisconnected();
      setConnected(false);
    };
  }, [api, activeSessionId, chatStore, navigationGeneration]);
}
