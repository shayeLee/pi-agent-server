import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./components/Icon.js";
import { useWebAppController } from "./hooks/useWebAppController.js";
import { SessionList } from "./components/SessionList.js";
import { ProjectSwitcher } from "./components/ProjectSwitcher.js";
import { Chat } from "./components/Chat.js";
import { Inspector } from "./components/Inspector.js";

const SIDEBAR_DEFAULT = 264;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_RAIL = 56;
const DETAILS_DEFAULT = 380;
const DETAILS_MIN = 260;
const DETAILS_MAX = 500;

/** Agent harness 顶层布局；服务端状态与交互由 Web 专属 controller 提供。 */
export default function App() {
  const controller = useWebAppController();

  // 布局状态：折叠 + 宽度。矮视口（<480px）下侧栏默认收起为图标 rail，保证阅读与输入优先。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.matchMedia?.("(max-height: 480px)").matches ?? false,
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const themeOverridden = useRef(false);
  // Follow the system until the user manually chooses a theme in this page session.
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const syncTheme = (event: MediaQueryListEvent) => {
      if (!themeOverridden.current) setTheme(event.matches ? "dark" : "light");
    };
    if (media.addEventListener) {
      media.addEventListener("change", syncTheme);
      return () => media.removeEventListener("change", syncTheme);
    }
    if (media.addListener) {
      media.addListener(syncTheme);
      return () => media.removeListener(syncTheme);
    }
  }, []);
  // Keep inherited CSS tokens and the page background in sync with the single App theme source.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
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
  useEffect(() => { if (!activeSession) setDetailsCollapsed(true); }, [activeSession?.id]);
  const streaming =
    controller.chatState.phase === "streaming" || controller.chatState.phase === "queued";
  const queued = controller.chatState.phase === "queued";
  const canCreateSession =
    controller.canWrite && controller.projectAllowsCreation &&
    controller.sessions !== null &&
    controller.projects !== null &&
    controller.activeProjectId !== null &&
    (controller.projects.length === 0 || controller.projects.some((project) => project.id === controller.activeProjectId));

  const closeMobileSidebar = () => {
    if (!mobileSidebarOpen) return;
    setMobileSidebarOpen(false);
    window.setTimeout(() => mobileMenuRef.current?.focus(), 0);
  };

  const closeInspector = () => {
    setDetailsCollapsed(true);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid="toggle-events"]')?.focus(), 0);
  };

  useEffect(() => {
    const sidebarIsOverlay = mobileSidebarOpen && (window.matchMedia?.("(max-width: 1179px)").matches ?? false);
    const inspectorIsOverlay = !mobileSidebarOpen && !detailsCollapsed &&
      (window.matchMedia?.("(max-width: 1439px)").matches ?? false);
    if (!sidebarIsOverlay && !inspectorIsOverlay) return;
    const isSidebar = sidebarIsOverlay;
    const panel = document.querySelector<HTMLElement>(isSidebar ? '[data-testid="sidebar"]' : '[data-testid="inspector"]');
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? [])
      .filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector('.select-menu[data-open="true"], .model-thinking-picker[data-open="true"]')) return;
        event.preventDefault();
        if (isSidebar) closeMobileSidebar();
        else closeInspector();
      } else if (event.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen, detailsCollapsed]);

  const shellClass = [
    "app-shell",
    mobileSidebarOpen ? "mobile-sidebar-open" : "",
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
      data-theme={theme}
      style={{
        ["--layout-sidebar-width" as string]: sidebarCollapsed ? `${SIDEBAR_RAIL}px` : `${sidebarWidth}px`,
        ["--layout-inspector-width" as string]: detailsCollapsed ? "0px" : `${detailsWidth}px`,
      }}
    >
      {/* 左侧边栏 */}
      <aside className="sidebar workbench-sidebar" data-testid="sidebar">
        <div className="sidebar-header workbench-sidebar-header">
          <div className="brand workbench-brand">
            <span className="brand-mark workbench-brand-mark" aria-hidden="true">π</span>
            <span className="brand-text workbench-brand-title">pi-agent-server</span>
          </div>
          <button
            className="btn-ghost btn-icon workbench-sidebar-toggle"
            data-testid="toggle-sidebar"
            onClick={() => {
              if (window.matchMedia?.("(max-width: 1179px)").matches) closeMobileSidebar();
              else setSidebarCollapsed((value) => !value);
            }}
            title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <button type="button" className="theme-toggle" data-testid="theme-toggle"
          aria-label={theme === "dark" ? "切换为亮色主题" : "切换为暗色主题"}
          onClick={() => {
            themeOverridden.current = true;
            setTheme((current) => current === "dark" ? "light" : "dark");
          }}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
        {controller.projects === null || controller.activeProjectId === null ? (
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
            {controller.sessions !== null && (
              <button
                className="new-session workbench-new-session"
                data-testid="new-session"
                disabled={!canCreateSession}
                title={controller.creationNotice ?? undefined}
                aria-describedby={controller.creationNotice ? "project-creation-notice" : undefined}
                onClick={() => { closeMobileSidebar(); controller.createSession(); }}
              >
                <Icon name="plus" className="new-session-icon" />
                <span className="new-session-label">新建会话</span>
              </button>
            )}
            {controller.creationNotice && <small id="project-creation-notice" role="status">{controller.creationNotice}</small>}
            <div className="workbench-nav-body">
              <div className="workbench-section-header">工作区 / 项目</div>
              {controller.projects && (
                <ProjectSwitcher
                  projects={controller.projects}
                  activeId={controller.activeProjectId}
                  onSelect={(id) => { closeMobileSidebar(); controller.selectProject(id); }}
                  onCreate={controller.createProject}
                  onDelete={controller.deleteProject}
                />
              )}
              {controller.sessions === null ? (
                <>
                  <div className="workbench-section-header">会话历史</div>
                  <div className="empty-hint" data-testid="sessions-loading">加载中…</div>
                </>
              ) : (
                <SessionList
                  sessions={controller.sessions}
                  activeId={controller.activeSessionId}
                  onSelect={(id) => { closeMobileSidebar(); controller.selectSession(id); }}
                  onDelete={controller.deleteSession}
                  onRename={controller.renameSession}
                  onExport={controller.exportSession}
                />
              )}
            </div>
          </>
        )}
      </aside>

      <button
        ref={mobileMenuRef}
        type="button"
        className="workbench-mobile-menu"
        aria-label="打开工作区导航"
        aria-expanded={mobileSidebarOpen}
        onClick={() => { setDetailsCollapsed(true); setMobileSidebarOpen(true); }}
      >
        <Icon name="menu" />
      </button>
      {mobileSidebarOpen && <button type="button" className="workbench-drawer-backdrop" aria-label="关闭工作区导航" onClick={closeMobileSidebar} />}

      {/* 聊天区 */}
      <Chat
        session={activeSession}
        projects={controller.projects}
        activeProjectId={controller.activeProjectId}
        onSelectProject={controller.selectProject}
        canCreateSession={canCreateSession}
        canWrite={controller.canWrite && (activeSession !== null || controller.projectAllowsCreation)}
        timeline={controller.chatState.timeline}
        historyLoading={controller.historyLoading}
        historyNotice={controller.historyNotice}
        streaming={streaming}
        queued={queued}
        loadError={controller.loadError}
        models={controller.models}
        thinkingLevels={controller.thinkingLevels}
        defaultModel={controller.defaultModel}
        defaultThinkingLevel={controller.defaultThinkingLevel}
        connected={controller.connected}
        stats={controller.chatState.stats}
        modelOutput={controller.chatState.modelOutput}
        activeTools={!!controller.chatState.activeToolCallIds?.length}
        draftSource={controller.draftSource}
        draftScope={controller.draftScope}
        submission={controller.submitState}
        pendingControls={controller.pendingControls}
        onDraftText={controller.setUnsentText}
        onDraftSettings={controller.setNewSessionSettings}
        onAddFile={controller.addUnsentFile}
        onRetryFile={controller.retryUnsentAttachment}
        onRemoveFile={controller.removeUnsentAttachment}
        onRetrySubmit={controller.retryFailedSubmission}
        onConfirmCreation={controller.confirmUnknownCreation}
        onSend={activeSession ? controller.sendMessage : controller.createSessionWithMessage}
        onSteer={controller.steer}
        onFollowUp={controller.followUp}
        onAbort={controller.abort}
        onToggleDetails={() => { setMobileSidebarOpen(false); setDetailsCollapsed((value) => !value); }}
        onSelectTab={(tab) => { setMobileSidebarOpen(false); setDetailsCollapsed(tab === "chat"); }}
        traceActive={!detailsCollapsed}
        onConfigChange={(config) => {
          if (activeSession) void controller.changeSessionConfig(activeSession.id, config);
        }}
      />

      {/* 右侧 Inspector */}
      {activeSession && !detailsCollapsed && <button type="button" className="workbench-inspector-backdrop" aria-label="关闭审查器" onClick={closeInspector} />}
      {activeSession && !detailsCollapsed && (
        <Inspector
          onClose={closeInspector}
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
