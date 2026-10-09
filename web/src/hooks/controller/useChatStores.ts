import { useMemo, useRef, useState, type RefObject } from "react";
import { createChatStore } from "pi-agent-server/client";
import type { ChatStore } from "pi-agent-server/client";

/** Per-session chat stores, SSE cursors and history readiness, kept across navigation. */
export function useChatStores(activeSessionIdRef: RefObject<string | null>) {
  const [historyReadySessionIds, setHistoryReadySessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const newlyCreatedIdsRef = useRef(new Set<string>());
  const historyReadySessionIdsRef = useRef(new Set<string>());
  const chatStoresRef = useRef(new Map<string, ChatStore>());
  // A cached timeline must resume from its consumed cursor, not a newer export cursor:
  // events missed while deselected also close the old owner before a host follow-up starts.
  const eventCursorsRef = useRef(new Map<string, number>());
  const emptyChatStore = useMemo(() => createChatStore(), []);
  function getChatStore(sessionId: string): ChatStore {
    let store = chatStoresRef.current.get(sessionId);
    if (!store) {
      store = createChatStore();
      chatStoresRef.current.set(sessionId, store);
    }
    return store;
  }
  function markHistoryReady(sessionId: string): void {
    historyReadySessionIdsRef.current.add(sessionId);
    setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));
  }
  function forgetSession(sessionId: string): void {
    chatStoresRef.current.delete(sessionId);
    eventCursorsRef.current.delete(sessionId);
    historyReadySessionIdsRef.current.delete(sessionId);
    setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));
  }
  function reportChatError(sessionId: string, err: unknown): void {
    if (activeSessionIdRef.current !== sessionId) return;
    getChatStore(sessionId).setError(err instanceof Error ? err.message : String(err));
  }

  return {
    historyReadySessionIds,
    historyReadySessionIdsRef,
    newlyCreatedIdsRef,
    chatStoresRef,
    eventCursorsRef,
    emptyChatStore,
    getChatStore,
    markHistoryReady,
    forgetSession,
    reportChatError,
  };
}

export type ChatStores = ReturnType<typeof useChatStores>;
