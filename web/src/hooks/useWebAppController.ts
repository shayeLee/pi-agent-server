import { useEffect, useMemo } from "react";
import { ApiClient } from "pi-agent-server/client";
import { useSelection } from "./controller/useSelection.js";
import { useChatStores } from "./controller/useChatStores.js";
import { useUsage } from "./controller/useUsage.js";
import { useSessionList } from "./controller/useSessionList.js";
import { useAccess, useModelCatalog } from "./controller/useCatalog.js";
import { useProjects } from "./controller/useProjects.js";
import { useSessions } from "./controller/useSessions.js";
import { useDrafts } from "./controller/useDrafts.js";
import { useSubmission } from "./controller/useSubmission.js";
import { useControls } from "./controller/useControls.js";
import { useSessionActions } from "./controller/useSessionActions.js";
import { useSessionStream } from "./controller/useSessionStream.js";

/**
 * Web 页面专属服务端状态适配层：封装 API 编排与 SSE 聊天状态。
 * Composes per-feature hooks; their call order fixes effect order (selection refs -> bootstrap ->
 * project sessions -> session stream), which the restore and submission flows rely on.
 */
export function useWebAppController() {
  const api = useMemo(() => new ApiClient({ baseUrl: "" }), []);
  const selection = useSelection();
  const chats = useChatStores(selection.activeSessionIdRef);
  const usage = useUsage();
  const sessionList = useSessionList();
  const { access, loadAccess } = useAccess(api);
  const catalog = useModelCatalog(api);
  const projects = useProjects({ api, selection, sessionList });

  useEffect(() => {
    if (api) {
      // 先确定默认项目；会话列表由 activeProjectId effect 加载。
      loadAccess();
      void projects.refreshProjects();
      void catalog.refreshModels();
    }
  }, [api]);

  const sessions = useSessions({ api, selection, chats, sessionList, usage, refreshProjects: projects.refreshProjects });
  const drafts = useDrafts({ api, selection, sessions: sessionList.sessions });
  const submission = useSubmission({
    api, selection, chats, sessionList, drafts,
    draftProjectsRef: projects.draftProjectsRef,
    projectAllowsCreation: projects.projectAllowsCreation,
    setLoadError: sessions.setLoadError,
  });
  const controls = useControls({ api, selection, chats, drafts, captureSnapshot: submission.captureSnapshot });
  const actions = useSessionActions({ api, selection, chats, sessionList, usage });
  const stream = useSessionStream({ api, selection, chats, usage, sessionList, submission, controls });

  const { activeSessionId } = selection;
  return {
    sessions: sessionList.sessions,
    canWrite: access?.canWrite === true,
    projectAllowsCreation: projects.projectAllowsCreation,
    creationNotice: projects.creationNotice,
    activeSessionId,
    selectSession: sessions.selectSession,
    projects: projects.projects,
    activeProjectId: selection.activeProjectId,
    selectProject: projects.selectProject,
    models: catalog.models,
    thinkingLevels: catalog.thinkingLevels,
    defaultModel: catalog.defaultModel,
    defaultThinkingLevel: catalog.defaultThinkingLevel,
    chatState: usage.visibleChatState(stream.rawChatState, activeSessionId),
    draftSource: drafts.draftStore,
    draftScope: selection.currentScope,
    submitState: submission.submitState,
    pendingControls: controls.pendingControls,
    setUnsentText: drafts.setUnsentText,
    setNewSessionSettings: drafts.setNewSessionSettings,
    addUnsentFile: drafts.addUnsentFile,
    retryUnsentAttachment: drafts.retryUnsentAttachment,
    removeUnsentAttachment: drafts.removeUnsentAttachment,
    retryFailedSubmission: submission.retryFailedSubmission,
    confirmUnknownCreation: submission.confirmUnknownCreation,
    historyLoading: activeSessionId !== null && !chats.historyReadySessionIds.has(activeSessionId),
    loadError: sessions.loadError,
    projectsError: projects.projectsError,
    eventLog: stream.eventLog,
    connected: stream.connected,
    historyNotice: stream.historyNotice,
    retryProjects: projects.retryProjects,
    createSession: submission.createSession,
    createSessionWithMessage: submission.createSessionWithMessage,
    createProject: projects.createProject,
    deleteProject: projects.deleteProject,
    deleteSession: sessions.deleteSession,
    renameSession: sessions.renameSession,
    exportSession: actions.exportSession,
    changeSessionConfig: actions.changeSessionConfig,
    sendMessage: submission.sendMessage,
    steer: controls.steer,
    followUp: controls.followUp,
    abort: actions.abort,
    clearEventLog: stream.clearEventLog,
  };
}

export type WebAppController = ReturnType<typeof useWebAppController>;
