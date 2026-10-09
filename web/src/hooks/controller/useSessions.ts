import { useEffect, useState } from "react";
import { ApiError } from "pi-agent-server/client";
import type { ApiClient } from "pi-agent-server/client";
import { clearRecentSelection, readRecentSelection, writeRecentSelection } from "../../recent-selection.js";
import type { ChatStores } from "./useChatStores.js";
import type { Selection } from "./useSelection.js";
import type { SessionList } from "./useSessionList.js";
import type { Usage } from "./useUsage.js";

/** Loads the active project's sessions (completing a pending restore) and handles select/rename/delete. */
export function useSessions({ api, selection, chats, sessionList, usage, refreshProjects }: {
  api: ApiClient;
  selection: Selection;
  chats: ChatStores;
  sessionList: SessionList;
  usage: Usage;
  refreshProjects: () => Promise<void>;
}) {
  const {
    activeSessionId, setActiveSessionId, activeProjectId, activeProjectIdRef,
    selectionRevisionRef, navigationGenerationRef, pendingRestoreRef, rememberSelection, cancelRetries,
  } = selection;
  const { setSessions, explicitTitlesRef, sessionsRequestSeqRef, mergeTitleMetadata } = sessionList;
  const { getChatStore } = chats;
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refreshSessions(projectId: string): Promise<void> {
    if (!api) return;
    const seq = ++sessionsRequestSeqRef.current;
    const titlesAtStart = new Map(explicitTitlesRef.current);
    try {
      setLoadError(null);
      const list = await api.listSessionsByProject(projectId);
      if (seq !== sessionsRequestSeqRef.current || activeProjectIdRef.current !== projectId) return;
      setSessions(list.map((row) => mergeTitleMetadata(row,
        titlesAtStart.get(row.id) !== explicitTitlesRef.current.get(row.id))));
      const restore = pendingRestoreRef.current;
      if (restore?.projectId === projectId && restore.revision === selectionRevisionRef.current) {
        pendingRestoreRef.current = null;
        if (list.some(row => row.id === restore.sessionId && row.projectId === projectId)) {
          getChatStore(restore.sessionId);
          writeRecentSelection(projectId, restore.sessionId);
          setActiveSessionId(restore.sessionId);
        } else {
          clearRecentSelection();
        }
      }
    } catch (err) {
      if (seq !== sessionsRequestSeqRef.current) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404) && pendingRestoreRef.current?.projectId === projectId) {
        pendingRestoreRef.current = null;
        clearRecentSelection();
      }
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (api && activeProjectId !== null) {
      setActiveSessionId(null);
      setSessions(null); // 切换项目时先隐藏旧项目会话，待新列表加载后才允许创建
      void refreshSessions(activeProjectId);
    }
  }, [api, activeProjectId]);

  async function deleteSession(id: string): Promise<void> {
    if (!api) return;
    await api.deleteSession(id);
    cancelRetries(id);
    chats.forgetSession(id);
    setSessions((prev) => (prev ?? []).filter((session) => session.id !== id));
    if (readRecentSelection()?.sessionId === id) clearRecentSelection();
    if (id === activeSessionId) {
      ++navigationGenerationRef.current;
      ++selectionRevisionRef.current;
      pendingRestoreRef.current = null;
      setActiveSessionId(null);
    }
    await refreshProjects();
  }

  async function renameSession(id: string, title: string): Promise<void> {
    if (!api) return;
    const projectId = activeProjectIdRef.current;
    const updated = await api.renameSession(id, title);
    explicitTitlesRef.current.set(id, updated.title);
    // Old-project completion must not invalidate the new project's pending list.
    if (activeProjectIdRef.current !== projectId || updated.projectId !== projectId) return;
    setSessions((prev) => prev?.map((session) => (session.id === id ? mergeTitleMetadata(updated) : session)) ?? null);
  }

  function selectSession(sessionId: string | null): void {
    if (activeProjectId) rememberSelection(activeProjectId, sessionId);
    if (sessionId !== null) {
      getChatStore(sessionId);
      if (sessionId !== activeSessionId) usage.invalidateContext(sessionId);
    }
    setActiveSessionId(sessionId);
  }

  return { loadError, setLoadError, deleteSession, renameSession, selectSession };
}
