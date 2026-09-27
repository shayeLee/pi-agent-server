import { useCallback, useRef, useState } from "react";
import { useWebAppController } from "./hooks/useWebAppController.js";
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

/** Agent harness 顶层布局；服务端状态与交互由 Web 专属 controller 提供。 */
export default function App() {
  const controller = useWebAppController();

  // 布局状态：折叠 + 宽度
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
  const [dragging, setDragging] = useState<"sidebar" | "details" | null>(null);

  // 拖拽调整列宽
  const dragStart = useRef({ x: 0, width: 0 });
  const handlePointerDown = useCallback(
    (side: "sidebar" | "details", event: React.PointerEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(side);
      dragStart.current = {
        x: event.clientX,
        width: side === "sidebar" ? sidebarWidth : detailsWidth,
      };
    },
    [sidebarWidth, detailsWidth],
  );
  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - dragStart.current.x;
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
  const handlePointerUp = useCallback((event: React.PointerEvent) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
  }, []);

  const activeSession =
    controller.sessions?.find((session) => session.id === controller.activeSessionId) ?? null;
  const streaming =
    controller.chatState.phase === "streaming" || controller.chatState.phase === "queued";
  const queued = controller.chatState.phase === "queued";

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
            onClick={() => setSidebarCollapsed((value) => !value)}
            title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
        </div>
        {controller.sessions === null || controller.activeProjectId === null ? (
          controller.projectsError ? (
            <div className="project-error" role="alert" data-testid="projects-error">
              <p className="project-error-text">{controller.projectsError}</p>
              <button
                className="btn-ghost project-retry"
                data-testid="retry-projects"
                onClick={() => void controller.retryProjects()}
              >
                重试加载项目
              </button>
            </div>
          ) : (
            <div className="empty-hint" data-testid="sessions-loading">
              加载中…
            </div>
          )
        ) : (
          <>
            <button
              className="new-session"
              data-testid="new-session"
              onClick={() => void controller.createSession()}
            >
              <span>+</span>
              <span className="new-session-label">新建会话</span>
            </button>
            {controller.projects && (
              <ProjectSwitcher
                projects={controller.projects}
                activeId={controller.activeProjectId}
                onSelect={controller.selectProject}
                onCreate={controller.createProject}
                onDelete={controller.deleteProject}
              />
            )}
            <SessionList
              sessions={controller.sessions}
              activeId={controller.activeSessionId}
              onSelect={controller.selectSession}
              onDelete={controller.deleteSession}
              onRename={controller.renameSession}
              onExport={controller.exportSession}
            />
          </>
        )}
      </aside>

      {/* 聊天区 */}
      <Chat
        session={activeSession}
        timeline={controller.chatState.timeline}
        historyLoading={controller.historyLoading}
        streaming={streaming}
        queued={queued}
        loadError={controller.loadError}
        models={controller.models}
        thinkingLevels={controller.thinkingLevels}
        defaultModel={controller.defaultModel}
        defaultThinkingLevel={controller.defaultThinkingLevel}
        connected={controller.connected}
        stats={controller.chatState.stats}
        onSend={controller.sendMessage}
        onSteer={controller.steer}
        onFollowUp={controller.followUp}
        onAbort={controller.abort}
        onToggleDetails={() => setDetailsCollapsed((value) => !value)}
        onConfigChange={(config) => {
          if (activeSession) void controller.changeSessionConfig(activeSession.id, config);
        }}
      />

      {/* 右侧 Inspector */}
      {!detailsCollapsed && (
        <Inspector
          session={activeSession}
          entries={controller.eventLog}
          timeline={controller.chatState.timeline}
          onClearEvents={controller.clearEventLog}
        />
      )}

      {/* 拖拽手柄 */}
      {!sidebarCollapsed && (
        <div
          className={`resize-handle sidebar ${dragging === "sidebar" ? "dragging" : ""}`}
          onPointerDown={(event) => handlePointerDown("sidebar", event)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
      {!detailsCollapsed && (
        <div
          className={`resize-handle details ${dragging === "details" ? "dragging" : ""}`}
          onPointerDown={(event) => handlePointerDown("details", event)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
    </main>
  );
}
