import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { FormEvent } from "react";
import { ApiClient, ApiError } from "./lib/api.js";
import { createSseConnection } from "./lib/sse-client.js";
import { applySseEvent, addUserMessage, createChatState } from "./lib/chat-state.js";
import type { ChatState } from "./lib/chat-state.js";
import type { EventLogEntry, ModelInfo, Project, SessionRecord, SseEvent } from "./types.js";
import { SessionList } from "./components/SessionList.js";
import { ProjectSwitcher } from "./components/ProjectSwitcher.js";
import { Chat } from "./components/Chat.js";
import { Inspector } from "./components/Inspector.js";

const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_RAIL = 56;
const DETAILS_DEFAULT = 320;
const DETAILS_MIN = 240;
const DETAILS_MAX = 500;

/**
 * Agent harness 顶层（DeepSeek Harness 风格布局）：
 * 可折叠/可拖拽的左侧边栏 | 居中聊天区 | 可折叠/可拖拽的右侧 Inspector。
 */
export default function App() {
  const [tokenDraft, setTokenDraft] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string>("default");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelInfo | null>(null);
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState("medium");
  const [chatState, setChatState] = useState<ChatState>(createChatState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  // 布局状态：折叠 + 宽度
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
  const [dragging, setDragging] = useState<"sidebar" | "details" | null>(null);

  const activeSessionIdRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev && prev !== activeSessionId) {
      for (const key of [...confirmedRequestsRef.current]) {
        if (key.startsWith(`${prev}:`)) confirmedRequestsRef.current.delete(key);
      }
    }
    prevSessionIdRef.current = activeSessionId;
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const retryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const confirmedRequestsRef = useRef(new Set<string>());
  const eventSeqRef = useRef(0);

  const api = useMemo(() => (token !== null ? new ApiClient("", token) : null), [token]);

  useEffect(() => {
    let cancelled = false;
    new ApiClient("", "")
      .listSessions()
      .then(() => {
        if (!cancelled) setToken("");
      })
      .catch(() => {
        if (!cancelled) setNeedToken(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshSessions(projectId = activeProjectId): Promise<void> {
    if (!api) return;
    try {
      setLoadError(null);
      setSessions(await api.listSessionsByProject(projectId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshProjects(): Promise<void> {
    if (!api) return;
    try {
      const list = await api.listProjects();
      setProjects(list);
      if (!list.some((p) => p.id === activeProjectId)) {
        setActiveProjectId("default");
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
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
      // 模型列表加载失败不阻塞主流程
    }
  }

  useEffect(() => {
    if (api) {
      void refreshProjects();
      void refreshSessions();
      void refreshModels();
    }
  }, [api]);

  useEffect(() => {
    if (api) {
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
    setChatState(createChatState());
    setEventLog([]);
    let cancelled = false;
    let connection: { close: () => void } | null = null;

    void (async () => {
      let cursor = 0;
      try {
        const data = (await api.exportSession(activeSessionId)) as {
          messages?: unknown;
          lastEventId?: number;
        };
        if (cancelled) return;
        const messages = data?.messages ?? data;
        const history = (Array.isArray(messages) ? messages : [])
          .filter(
            (m): m is { role: string; text: string } =>
              typeof m === "object" &&
              m !== null &&
              typeof (m as { text?: unknown }).text === "string",
          )
          .map((m, i) => ({
            kind: "message" as const,
            id: `hist-${i}`,
            role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
            text: m.text,
            streaming: false,
          }));
        if (history.length > 0) {
          setChatState((prev) => ({ ...prev, timeline: history }));
        }
        if (typeof data?.lastEventId === "number") cursor = data.lastEventId;
      } catch {
        // 导出失败仅影响历史展示
      }
      if (cancelled) return;

      connection = createSseConnection({
        url: `/v1/sessions/${activeSessionId}/events`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        lastEventId: cursor,
        onOpen: () => {
          if (!cancelled) setConnected(true);
        },
        onError: () => {
          if (!cancelled) setConnected(false);
        },
        onEvent: (event) => {
          if ((event.type === "queued" || event.type === "status") && event.requestId) {
            confirmedRequestsRef.current.add(`${activeSessionId}:${event.requestId}`);
          }
          if (event.type === "completed" || event.type === "error" || event.type === "aborted") {
            for (const key of [...confirmedRequestsRef.current]) {
              if (key.startsWith(`${activeSessionId}:`)) confirmedRequestsRef.current.delete(key);
            }
          }
          logEvent(event);
          setChatState((prev) => applySseEvent(prev, event));
        },
      });
    })();

    return () => {
      cancelled = true;
      connection?.close();
      setConnected(false);
    };
  }, [api, activeSessionId, token]);

  function handleTokenSubmit(e: FormEvent): void {
    e.preventDefault();
    const value = tokenDraft.trim();
    if (!value) return;
    setToken(value);
    setTokenDraft("");
  }

  function handleSelect(id: string): void {
    setActiveSessionId(id);
  }

  async function handleCreate(): Promise<void> {
    if (!api) return;
    const session = await api.createSession(undefined, activeProjectId);
    setSessions((prev) => [...(prev ?? []), session]);
    setActiveSessionId(session.id);
  }

  async function handleCreateProject(name: string, cwd: string): Promise<void> {
    if (!api) return;
    await api.createProject(name, cwd);
    await refreshProjects();
  }

  async function handleDeleteProject(id: string): Promise<void> {
    if (!api) return;
    await api.deleteProject(id);
    await refreshProjects();
    if (id === activeProjectId) {
      setActiveProjectId("default");
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!api) return;
    await api.deleteSession(id);
    setSessions((prev) => (prev ?? []).filter((s) => s.id !== id));
    if (id === activeSessionId) setActiveSessionId(null);
    for (const key of [...confirmedRequestsRef.current]) {
      if (key.startsWith(`${id}:`)) confirmedRequestsRef.current.delete(key);
    }
  }

  async function handleRename(id: string, title: string): Promise<void> {
    if (!api) return;
    const updated = await api.renameSession(id, title);
    setSessions((prev) => (prev ?? []).map((s) => (s.id === id ? updated : s)));
  }

  async function handleConfigChange(
    id: string,
    config: { modelProvider?: string; modelId?: string; thinkingLevel?: string },
  ): Promise<void> {
    if (!api) return;
    try {
      const updated = await api.updateSessionConfig(id, config);
      setSessions((prev) => (prev ?? []).map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      reportChatError(id, err);
    }
  }

  async function handleExport(id: string): Promise<void> {
    if (!api) return;
    try {
      const data = await api.exportSession(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `session-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      reportChatError(id, err);
    }
  }

  function reportChatError(sid: string, err: unknown): void {
    if (activeSessionIdRef.current !== sid) return;
    setChatState((prev) => ({
      ...prev,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  function reportSendError(sid: string, requestId: string, messageId: string, err: unknown): void {
    if (activeSessionIdRef.current !== sid) return;
    if (confirmedRequestsRef.current.has(`${sid}:${requestId}`)) return;
    setChatState((prev) => {
      const last = prev.timeline[prev.timeline.length - 1];
      const isPending =
        last?.kind === "message" && last.id === messageId && prev.phase === "queued";
      if (!isPending) return prev;
      return {
        ...prev,
        timeline: prev.timeline.filter((m) => !(m.kind === "message" && m.id === messageId)),
        phase: "idle",
        error: err instanceof Error ? err.message : String(err),
      };
    });
  }

  function handleSend(text: string): void {
    if (!api || !activeSessionId) return;
    const sid = activeSessionId;
    const messageId = `user-${crypto.randomUUID()}`;
    setChatState((prev) => addUserMessage(prev, text, messageId));
    const requestId = crypto.randomUUID();
    sendWithRetry(sid, requestId, messageId, text, 0);
  }

  function sendWithRetry(
    sid: string,
    requestId: string,
    messageId: string,
    text: string,
    attempt: number,
  ): void {
    api!.sendMessage(sid, { requestId, prompt: text }).catch((err) => {
      if (err instanceof ApiError && err.status < 500) {
        reportSendError(sid, requestId, messageId, err);
        return;
      }
      if (attempt < 3) {
        const timer = setTimeout(
          () => sendWithRetry(sid, requestId, messageId, text, attempt + 1),
          1000,
        );
        retryTimersRef.current.add(timer);
      } else {
        reportSendError(sid, requestId, messageId, err);
      }
    });
  }

  function handleSteer(text: string): void {
    if (!api || !activeSessionId) return;
    const sid = activeSessionId;
    api.steer(sid, text).catch((err) => reportChatError(sid, err));
  }

  function handleFollowUp(text: string): void {
    if (!api || !activeSessionId) return;
    const sid = activeSessionId;
    api.followUp(sid, text).catch((err) => reportChatError(sid, err));
  }

  function handleAbort(): void {
    if (!api || !activeSessionId) return;
    const sid = activeSessionId;
    api.abort(sid).catch((err) => reportChatError(sid, err));
  }

  // 拖拽调整列宽
  const dragStart = useRef({ x: 0, width: 0 });
  const handlePointerDown = useCallback(
    (side: "sidebar" | "details", e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(side);
      dragStart.current = {
        x: e.clientX,
        width: side === "sidebar" ? sidebarWidth : detailsWidth,
      };
    },
    [sidebarWidth, detailsWidth],
  );
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      if (dragging === "sidebar") {
        const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStart.current.width + dx));
        setSidebarWidth(next);
        setSidebarCollapsed(next < SIDEBAR_MIN + 40);
      } else {
        const next = Math.min(DETAILS_MAX, Math.max(DETAILS_MIN, dragStart.current.width - dx));
        setDetailsWidth(next);
        setDetailsCollapsed(next < DETAILS_MIN + 40);
      }
    },
    [dragging],
  );
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(null);
  }, []);

  if (token === null && !needToken) {
    return (
      <main className="auth-screen">
        <h1>pi-agent-server</h1>
        <div data-testid="auth-probing">检测访问方式…</div>
      </main>
    );
  }

  if (!api) {
    return (
      <main className="auth-screen">
        <h1>pi-agent-server</h1>
        <form onSubmit={handleTokenSubmit}>
          <input
            data-testid="token-input"
            type="password"
            aria-label="token"
            placeholder="输入访问 token（仅保存在内存）"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          <button className="btn-primary" type="submit" data-testid="token-submit">
            进入
          </button>
        </form>
      </main>
    );
  }

  const activeSession = sessions?.find((s) => s.id === activeSessionId) ?? null;
  const streaming = chatState.phase === "streaming" || chatState.phase === "queued";
  const queued = chatState.phase === "queued";

  const shellClass = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    detailsCollapsed ? "details-collapsed" : "",
    dragging ? "dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      className={shellClass}
      data-testid="app"
      style={{
        ["--ds-sidebar-w" as string]: sidebarCollapsed ? `${SIDEBAR_RAIL}px` : `${sidebarWidth}px`,
        ["--ds-details-w" as string]: detailsCollapsed ? "0px" : `${detailsWidth}px`,
      }}
    >
      {/* 左侧边栏 */}
      <aside className="sidebar" data-testid="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <span className="brand-dot" />
            <span className="brand-text">pi-agent-server</span>
          </div>
          <button
            className="btn-ghost btn-icon"
            data-testid="toggle-sidebar"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
        </div>
        {sessions === null ? (
          <div className="empty-hint" data-testid="sessions-loading">
            加载中…
          </div>
        ) : (
          <>
            <button className="new-session" data-testid="new-session" onClick={handleCreate}>
              <span>+</span>
              <span className="new-session-label">新建会话</span>
            </button>
            {projects && (
              <ProjectSwitcher
                projects={projects}
                activeId={activeProjectId}
                onSelect={setActiveProjectId}
                onCreate={handleCreateProject}
                onDelete={handleDeleteProject}
              />
            )}
            <SessionList
              sessions={sessions}
              activeId={activeSessionId}
              onSelect={handleSelect}
              onDelete={handleDelete}
              onRename={handleRename}
              onExport={handleExport}
            />
          </>
        )}
      </aside>

      {/* 聊天区 */}
      <Chat
        session={activeSession}
        timeline={chatState.timeline}
        streaming={streaming}
        queued={queued}
        loadError={loadError}
        models={models}
        thinkingLevels={thinkingLevels}
        defaultModel={defaultModel}
        defaultThinkingLevel={defaultThinkingLevel}
        connected={connected}
        stats={chatState.stats}
        onSend={handleSend}
        onSteer={handleSteer}
        onFollowUp={handleFollowUp}
        onAbort={handleAbort}
        onToggleDetails={() => setDetailsCollapsed((v) => !v)}
        onConfigChange={(config) => {
          if (activeSession) void handleConfigChange(activeSession.id, config);
        }}
      />

      {/* 右侧 Inspector */}
      {!detailsCollapsed && (
        <Inspector
          session={activeSession}
          entries={eventLog}
          timeline={chatState.timeline}
          onClearEvents={() => setEventLog([])}
        />
      )}

      {/* 拖拽手柄 */}
      {!sidebarCollapsed && (
        <div
          className={`resize-handle sidebar ${dragging === "sidebar" ? "dragging" : ""}`}
          onPointerDown={(e) => handlePointerDown("sidebar", e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
      {!detailsCollapsed && (
        <div
          className={`resize-handle details ${dragging === "details" ? "dragging" : ""}`}
          onPointerDown={(e) => handlePointerDown("details", e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
    </main>
  );
}
