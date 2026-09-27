import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiClient, ApiError, createChatStore, createSseConnection } from "pi-agent-server/client";
import type { ChatStore, ModelInfo, Project, SessionRecord, SseEvent } from "pi-agent-server/client";
import type { EventLogEntry } from "../types.js";

/** Web 页面专属服务端状态适配层：封装 API 编排与 SSE 聊天状态。 */
export function useWebAppController() {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  // 项目列表加载前不选项目；默认项目完全由服务端 isDefault 字段推导。
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelInfo | null>(null);
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState("medium");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [historyReadySessionIds, setHistoryReadySessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const historyReadySessionIdsRef = useRef(new Set<string>());
  const chatStoresRef = useRef(new Map<string, ChatStore>());
  const emptyChatStore = useMemo(() => createChatStore(), []);
  function getChatStore(sessionId: string): ChatStore {
    let store = chatStoresRef.current.get(sessionId);
    if (!store) {
      store = createChatStore();
      chatStoresRef.current.set(sessionId, store);
    }
    return store;
  }
  const chatStore =
    activeSessionId === null
      ? emptyChatStore
      : (chatStoresRef.current.get(activeSessionId) ?? emptyChatStore);
  const subscribeChat = useCallback(
    (listener: () => void) => chatStore.subscribe(() => listener()),
    [chatStore],
  );
  const getChatSnapshot = useCallback(() => chatStore.getState(), [chatStore]);
  const chatState = useSyncExternalStore(subscribeChat, getChatSnapshot, getChatSnapshot);

  const activeSessionIdRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev && prev !== activeSessionId) {
      cancelRetries(prev);
      for (const key of [...confirmedRequestsRef.current]) {
        if (key.startsWith(`${prev}:`)) confirmedRequestsRef.current.delete(key);
      }
    }
    prevSessionIdRef.current = activeSessionId;
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const retryTimersRef = useRef(new Map<ReturnType<typeof setTimeout>, string>());
  function cancelRetries(sessionId: string): void {
    for (const [timer, owner] of retryTimersRef.current) {
      if (owner !== sessionId) continue;
      clearTimeout(timer);
      retryTimersRef.current.delete(timer);
    }
  }
  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      for (const timer of timers.keys()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const confirmedRequestsRef = useRef(new Set<string>());
  const eventSeqRef = useRef(0);
  // 快速切换项目时，旧会话请求的响应/错误不得覆盖当前项目状态。
  const sessionsRequestSeqRef = useRef(0);
  const api = useMemo(() => new ApiClient({ baseUrl: "" }), []);

  async function refreshSessions(projectId: string): Promise<void> {
    if (!api) return;
    const seq = ++sessionsRequestSeqRef.current;
    try {
      setLoadError(null);
      const list = await api.listSessionsByProject(projectId);
      if (seq !== sessionsRequestSeqRef.current) return;
      setSessions(list);
    } catch (err) {
      if (seq !== sessionsRequestSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshProjects(): Promise<void> {
    if (!api) return;
    try {
      const list = await api.listProjects();
      const defaultId = list.find((project) => project.isDefault)?.id ?? null;
      if (defaultId === null) {
        ++sessionsRequestSeqRef.current;
        setProjects(list);
        setProjectsError(
          "项目列表中没有默认项目（isDefault: true），无法确定默认项目，请检查服务端配置后重试。",
        );
        setActiveProjectId(null);
        setSessions(null);
        setActiveSessionId(null);
        return;
      }
      setProjects(list);
      setProjectsError(null);
      setActiveProjectId((prev) =>
        prev === null || !list.some((project) => project.id === prev) ? defaultId : prev,
      );
    } catch (err) {
      ++sessionsRequestSeqRef.current;
      setProjectsError(
        `项目列表加载失败：${err instanceof Error ? err.message : String(err)}。请确认服务可用后重试。`,
      );
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

  async function refreshModels(): Promise<void> {
    if (!api) return;
    try {
      const data = await api.listModels();
      setModels(data.models);
      setThinkingLevels(data.thinkingLevels);
      setDefaultModel(data.defaultModel);
      setDefaultThinkingLevel(data.defaultThinkingLevel);
    } catch {
      // 模型列表加载失败不阻塞主流程。
    }
  }

  useEffect(() => {
    if (api) {
      // 先确定默认项目；会话列表由 activeProjectId effect 加载。
      void refreshProjects();
      void refreshModels();
    }
  }, [api]);

  useEffect(() => {
    if (api && activeProjectId !== null) {
      setActiveSessionId(null);
      void refreshSessions(activeProjectId);
    }
  }, [api, activeProjectId]);

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
    const restoreOnLoad = !historyReadySessionIdsRef.current.has(sessionId);
    const stateAtLoadStart = store.getState();
    setEventLog([]);
    let cancelled = false;
    let connection: { close: () => void } | null = null;

    void (async () => {
      let cursor = 0;
      try {
        const data = (await api.exportSession(sessionId)) as {
          messages?: unknown;
          lastEventId?: number;
        };
        if (cancelled) return;
        const messages = data?.messages ?? data;
        const history = (Array.isArray(messages) ? messages : [])
          .filter(
            (message): message is { role: string; text: string } =>
              typeof message === "object" &&
              message !== null &&
              typeof (message as { text?: unknown }).text === "string",
          )
          .map((message, index) => ({
            kind: "message" as const,
            id: `hist-${index}`,
            role: (message.role === "user" ? "user" : "assistant") as "user" | "assistant",
            text: message.text,
            streaming: false,
          }));
        // Restore only the first baseline, and only if the store stayed untouched while loading.
        // Returning to a session must preserve its SSE stream and optimistic sends.
        if (
          restoreOnLoad &&
          store.getState() === stateAtLoadStart &&
          history.length > 0
        ) {
          store.restoreHistory(history);
        }
        if (typeof data?.lastEventId === "number") cursor = data.lastEventId;
      } catch {
        // 历史导出失败仅影响历史展示。
      }
      if (cancelled) return;
      historyReadySessionIdsRef.current.add(sessionId);
      setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));

      connection = createSseConnection({
        url: `/v1/sessions/${sessionId}/events`,
        lastEventId: cursor,
        onOpen: () => {
          if (!cancelled) setConnected(true);
        },
        onError: () => {
          if (!cancelled) setConnected(false);
        },
        onNoLiveStream: () => {
          if (!cancelled) setConnected(false);
        },
        onEvent: (event) => {
          if (cancelled) return;
          if ((event.type === "queued" || event.type === "status") && event.requestId) {
            confirmedRequestsRef.current.add(`${sessionId}:${event.requestId}`);
          }
          if (event.type === "completed" || event.type === "error" || event.type === "aborted") {
            for (const key of [...confirmedRequestsRef.current]) {
              if (key.startsWith(`${sessionId}:`)) confirmedRequestsRef.current.delete(key);
            }
          }
          logEvent(event);
          store.applyEvent(event);
        },
      });
    })();

    return () => {
      cancelled = true;
      connection?.close();
      setConnected(false);
    };
  }, [api, activeSessionId, chatStore]);

  function createSession(): Promise<void> {
    if (!api || activeProjectId === null) return Promise.resolve();
    return api.createSession(undefined, activeProjectId).then((session) => {
      setSessions((prev) => [...(prev ?? []), session]);
      getChatStore(session.id);
      setActiveSessionId(session.id);
    });
  }

  async function createProject(name: string, cwd: string): Promise<void> {
    if (!api) return;
    await api.createProject(name, cwd);
    await refreshProjects();
  }

  async function deleteProject(id: string): Promise<void> {
    if (!api) return;
    await api.deleteProject(id);
    await refreshProjects();
  }

  async function deleteSession(id: string): Promise<void> {
    if (!api) return;
    await api.deleteSession(id);
    cancelRetries(id);
    chatStoresRef.current.delete(id);
    historyReadySessionIdsRef.current.delete(id);
    setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));
    setSessions((prev) => (prev ?? []).filter((session) => session.id !== id));
    if (id === activeSessionId) setActiveSessionId(null);
    for (const key of [...confirmedRequestsRef.current]) {
      if (key.startsWith(`${id}:`)) confirmedRequestsRef.current.delete(key);
    }
  }

  async function renameSession(id: string, title: string): Promise<void> {
    if (!api) return;
    const updated = await api.renameSession(id, title);
    setSessions((prev) => (prev ?? []).map((session) => (session.id === id ? updated : session)));
  }

  function reportChatError(sessionId: string, err: unknown): void {
    if (activeSessionIdRef.current !== sessionId) return;
    getChatStore(sessionId).setError(err instanceof Error ? err.message : String(err));
  }

  async function changeSessionConfig(
    id: string,
    config: { modelProvider?: string; modelId?: string; thinkingLevel?: string },
  ): Promise<void> {
    if (!api) return;
    try {
      const updated = await api.updateSessionConfig(id, config);
      setSessions((prev) => (prev ?? []).map((session) => (session.id === id ? updated : session)));
    } catch (err) {
      reportChatError(id, err);
    }
  }

  async function exportSession(id: string): Promise<void> {
    if (!api) return;
    try {
      const data = await api.exportSession(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `session-${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      reportChatError(id, err);
    }
  }

  function reportSendError(
    sessionId: string,
    requestId: string,
    messageId: string,
    err: unknown,
  ): void {
    if (activeSessionIdRef.current !== sessionId) return;
    if (confirmedRequestsRef.current.has(`${sessionId}:${requestId}`)) return;
    getChatStore(sessionId).rollbackUserMessage(
      messageId,
      err instanceof Error ? err.message : String(err),
    );
  }

  function sendWithRetry(
    sessionId: string,
    requestId: string,
    messageId: string,
    text: string,
    attempt: number,
  ): void {
    if (!api || activeSessionIdRef.current !== sessionId) return;
    api.sendMessage(sessionId, { requestId, prompt: text }).catch((err) => {
      if (activeSessionIdRef.current !== sessionId) return;
      if (err instanceof ApiError && err.status < 500) {
        reportSendError(sessionId, requestId, messageId, err);
        return;
      }
      if (attempt < 3) {
        const timer = setTimeout(() => {
          retryTimersRef.current.delete(timer);
          sendWithRetry(sessionId, requestId, messageId, text, attempt + 1);
        }, 1000);
        retryTimersRef.current.set(timer, sessionId);
      } else {
        reportSendError(sessionId, requestId, messageId, err);
      }
    });
  }

  function sendMessage(text: string): void {
    if (!api || !activeSessionId || !historyReadySessionIdsRef.current.has(activeSessionId)) return;
    const sessionId = activeSessionId;
    const messageId = `user-${crypto.randomUUID()}`;
    getChatStore(sessionId).addUserMessage(text, messageId);
    const requestId = crypto.randomUUID();
    sendWithRetry(sessionId, requestId, messageId, text, 0);
  }

  function steer(text: string): void {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    api.steer(sessionId, text).catch((err) => reportChatError(sessionId, err));
  }

  function followUp(text: string): void {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    api.followUp(sessionId, text).catch((err) => reportChatError(sessionId, err));
  }

  function abort(): void {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    api.abort(sessionId).catch((err) => reportChatError(sessionId, err));
  }

  function clearEventLog(): void {
    setEventLog([]);
  }

  function selectSession(sessionId: string | null): void {
    if (sessionId !== null) getChatStore(sessionId);
    setActiveSessionId(sessionId);
  }

  return {
    sessions,
    activeSessionId,
    selectSession,
    projects,
    activeProjectId,
    selectProject: setActiveProjectId,
    models,
    thinkingLevels,
    defaultModel,
    defaultThinkingLevel,
    chatState,
    historyLoading: activeSessionId !== null && !historyReadySessionIds.has(activeSessionId),
    loadError,
    projectsError,
    eventLog,
    connected,
    retryProjects,
    createSession,
    createProject,
    deleteProject,
    deleteSession,
    renameSession,
    exportSession,
    changeSessionConfig,
    sendMessage,
    steer,
    followUp,
    abort,
    clearEventLog,
  };
}
