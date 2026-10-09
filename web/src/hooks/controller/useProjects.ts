import { useRef, useState } from "react";
import { DEFAULT_PROJECT_ID, ApiError } from "pi-agent-server/client";
import type { ApiClient, Project } from "pi-agent-server/client";
import { clearRecentSelection, readRecentSelection } from "../../recent-selection.js";
import type { Selection } from "./useSelection.js";
import type { SessionList } from "./useSessionList.js";

/** Project list, one-shot recent-selection restore, and project create/delete/select. */
export function useProjects({ api, selection, sessionList }: {
  api: ApiClient;
  selection: Selection;
  sessionList: SessionList;
}) {
  const {
    activeProjectId, setActiveProjectId, setActiveSessionId, activeProjectIdRef,
    selectionRevisionRef, navigationGenerationRef, restoreAttemptedRef, pendingRestoreRef, rememberSelection,
  } = selection;
  const { setSessions, sessionsRequestSeqRef } = sessionList;
  const [projects, setProjects] = useState<Project[] | null>(null);
  // Explicitly created, still-empty projects remain selectable in this browser.
  const draftProjectsRef = useRef(new Map<string, Project>());
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const projectsPromiseRef = useRef<Promise<void> | null>(null);

  function refreshProjects(): Promise<void> {
    if (projectsPromiseRef.current) return projectsPromiseRef.current;
    const promise = loadProjects().finally(() => {
      if (projectsPromiseRef.current === promise) projectsPromiseRef.current = null;
    });
    projectsPromiseRef.current = promise;
    return promise;
  }

  async function loadProjects(): Promise<void> {
    if (!api) return;
    const revision = selectionRevisionRef.current;
    try {
      const list = await api.listProjects();
      for (const project of list) draftProjectsRef.current.delete(project.id);
      list.push(...draftProjectsRef.current.values());
      const defaultId = list.find((project) => project.isDefault)?.id ?? list[0]?.id ?? DEFAULT_PROJECT_ID;
      let restoredProjectId: string | null = null;
      if (!restoreAttemptedRef.current && revision === selectionRevisionRef.current) {
        restoreAttemptedRef.current = true;
        const recent = readRecentSelection();
        if (recent) {
          try {
            // There is no detail GET. One metadata list resolves native session moves;
            // never probe every history/export or trust the stored project association.
            const record = recent.sessionId ? (await api.listSessions()).find(row => row.id === recent.sessionId) : null;
            if (revision === selectionRevisionRef.current) {
              const projectId = recent.sessionId ? record?.projectId : recent.projectId;
              if (projectId && list.some(project => project.id === projectId)) {
                restoredProjectId = projectId;
                if (recent.sessionId) pendingRestoreRef.current = { projectId, sessionId: recent.sessionId, revision };
              } else clearRecentSelection();
            }
          } catch (error) {
            // Transient failures preserve the hint; never send or create on restore.
            if (revision === selectionRevisionRef.current && error instanceof ApiError && (error.status === 403 || error.status === 404)) clearRecentSelection();
          }
        }
      }
      setProjects(list);
      setProjectsError(null);
      setActiveProjectId((prev) =>
        revision !== selectionRevisionRef.current && prev !== null ? prev :
        restoredProjectId ?? (prev === null || !list.some((project) => project.id === prev) ? defaultId : prev),
      );
    } catch (err) {
      if (revision === selectionRevisionRef.current && err instanceof ApiError && (err.status === 403 || err.status === 404)) clearRecentSelection();
      if (revision !== selectionRevisionRef.current) return;
      ++sessionsRequestSeqRef.current;
      setProjectsError(
        `项目列表加载失败：${err instanceof Error ? err.message : String(err)}。请确认服务可用后重试。`,
      );
      // Do not erase a newer user choice on an old request failure.
      if (revision !== selectionRevisionRef.current) return;
      // 默认项目未能确定时，不创建会话或查询特定项目会话。
      setActiveProjectId(null);
      setSessions(null);
      setActiveSessionId(null);
    }
  }

  async function retryProjects(): Promise<void> {
    setProjectsError(null);
    await refreshProjects();
  }

  const projectAllowsCreation = projects?.find(project => project.id === activeProjectId)?.canCreateSession !== false;
  const creationNotice = projectAllowsCreation ? null : "当前权限无法在此项目新建会话";

  async function createProject(name: string, cwd: string): Promise<void> {
    if (!api) return;
    ++navigationGenerationRef.current;
    ++selectionRevisionRef.current;
    pendingRestoreRef.current = null;
    const project = await api.createProject(name, cwd);
    rememberSelection(project.id, null);
    draftProjectsRef.current.set(project.id, project);
    setActiveProjectId(project.id);
    activeProjectIdRef.current = project.id;
    setActiveSessionId(null);
    setSessions([]);
    await refreshProjects();
  }

  async function deleteProject(id: string): Promise<void> {
    if (!api) return;
    await api.deleteProject(id);
    draftProjectsRef.current.delete(id);
    if (readRecentSelection()?.projectId === id) clearRecentSelection();
    await refreshProjects();
  }

  function selectProject(projectId: string): void {
    rememberSelection(projectId, null);
    setActiveSessionId(null);
    activeProjectIdRef.current = projectId;
    setActiveProjectId(projectId);
  }

  return {
    projects,
    projectsError,
    draftProjectsRef,
    projectAllowsCreation,
    creationNotice,
    refreshProjects,
    retryProjects,
    createProject,
    deleteProject,
    selectProject,
  };
}

export type Projects = ReturnType<typeof useProjects>;
