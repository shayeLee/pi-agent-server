import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readThemeMode, resolveTheme, writeThemeMode, type ThemeMode } from "./theme-preference.js";
import { Icon } from "./components/Icon.js";
import { useWebAppController } from "./hooks/useWebAppController.js";
import { SessionList } from "./components/SessionList.js";
import { ProjectSwitcher } from "./components/ProjectSwitcher.js";
import { Chat } from "./components/Chat.js";
import { Inspector, type InspectorTab } from "./components/Inspector.js";
import { useSessionInspection } from "./hooks/useSessionInspection.js";
import { zhCN } from "./i18n/zh-CN.js";
import brandImage from "./icons/svg/brand-pi.svg";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./components/ui/dropdown-menu.js";

const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_RAIL = 56;
const DETAILS_DEFAULT = 380;

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
  const shellRef = useRef<HTMLElement>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("steps");
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [theme, setTheme] = useState<"dark" | "light">(() => resolveTheme(themeMode));
  // Only system mode follows OS changes; manual choices survive reloads.
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const syncTheme = (event: MediaQueryListEvent) => {
      if (themeMode === "system") setTheme(event.matches ? "dark" : "light");
    };
    if (media.addEventListener) {
      media.addEventListener("change", syncTheme);
      return () => media.removeEventListener("change", syncTheme);
    }
    if (media.addListener) {
      media.addListener(syncTheme);
      return () => media.removeListener(syncTheme);
    }
  }, [themeMode]);
  // Keep inherited CSS tokens and the page background in sync with the single App theme source.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [dragging, setDragging] = useState<"sidebar" | null>(null);

  // 拖拽调整列宽
  const dragStart = useRef({ x: 0, width: 0 });
  const handlePointerDown = useCallback(
    (side: "sidebar", event: React.PointerEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(side);
      dragStart.current = {
        x: event.clientX,
        width: sidebarWidth,
      };
    },
    [sidebarWidth],
  );
  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - dragStart.current.x;
      if (dragging === "sidebar") {
        const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStart.current.width + dx));
        setSidebarWidth(next);
        setSidebarCollapsed(next < SIDEBAR_MIN + 40);
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
  const inspection = useSessionInspection({ api: controller.api, sessionId: activeSession?.id ?? null,
    visible: !detailsCollapsed && !mobileSidebarOpen, activeTab: inspectorTab,
    refreshKey: controller.inspectionRefreshKey });
  // The nested chat/inspector columns cannot share a CSS grid row. Measure only
  // the natural chat header (including its border); never feed this height back
  // into the chat, so wrapping and resize can also shrink it without a loop.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const header = shell?.querySelector<HTMLElement>('[data-testid="chat-header"]');
    if (!shell || !header || detailsCollapsed) return;
    const sync = () => {
      if (window.innerWidth > 600) shell.style.setProperty('--inspector-header-height', `${header.getBoundingClientRect().height}px`);
      else shell.style.removeProperty('--inspector-header-height');
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      shell.style.removeProperty('--inspector-header-height');
    };
  }, [activeSession?.id, detailsCollapsed]);
  const streaming = controller.chatState.phase === "streaming";
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
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid="trace-tab"]')?.focus(), 0);
  };

  useEffect(() => {
    const sidebarIsOverlay = mobileSidebarOpen && (window.matchMedia?.("(max-width: 1179px)").matches ?? false);
    const inspectorIsOpen = !mobileSidebarOpen && !detailsCollapsed;
    if (!sidebarIsOverlay && !inspectorIsOpen) return;
    const isSidebar = sidebarIsOverlay;
    const panel = document.querySelector<HTMLElement>(isSidebar ? '[data-testid="sidebar"]' : '[data-testid="inspector"]');
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? [])
      .filter((element) => element.getClientRects().length > 0);
    if (isSidebar) focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[data-ui="dropdown-menu"][data-state="open"]')) return;
      if (event.key === "Escape") {
        if (document.querySelector('.select-menu[data-open="true"], .model-thinking-picker[data-open="true"]')) return;
        event.preventDefault();
        if (isSidebar) closeMobileSidebar();
        else closeInspector();
      } else if (isSidebar && event.key === "Tab") {
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
      ref={shellRef}
      className={shellClass}
      data-testid="app"
      data-theme={theme}
      style={{
        ["--layout-sidebar-width" as string]: sidebarCollapsed ? `${SIDEBAR_RAIL}px` : `${sidebarWidth}px`,
        ["--layout-inspector-width" as string]: detailsCollapsed ? "0px" : `${DETAILS_DEFAULT}px`,
      }}
    >
      {/* 左侧边栏 */}
      <aside className="sidebar workbench-sidebar" data-testid="sidebar">
        <div className="sidebar-header workbench-sidebar-header">
          <div className="brand workbench-brand">
            <img className="brand-mark workbench-brand-mark" src={brandImage} width="26" height="26" alt="" aria-hidden="true" />
            <span className="brand-text workbench-brand-title">pi-agent-server</span>
          </div>
          <button
            className="btn-ghost btn-icon workbench-sidebar-toggle"
            data-testid="toggle-sidebar"
            onClick={() => {
              if (window.matchMedia?.("(max-width: 1179px)").matches) closeMobileSidebar();
              else setSidebarCollapsed((value) => !value);
            }}
            title={sidebarCollapsed ? zhCN.sidebar.expand : zhCN.sidebar.collapse}
            aria-label={sidebarCollapsed ? zhCN.sidebar.expand : zhCN.sidebar.collapse}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="theme-toggle" data-testid="theme-toggle" aria-label={zhCN.sidebar.themeMenu}>
              <Icon name={theme === "dark" ? "moon" : "sun"} /><span>{zhCN.sidebar.themeMenu}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" aria-label={zhCN.sidebar.themeMenu}>
            <DropdownMenuRadioGroup value={themeMode} onValueChange={(value) => {
              const mode = value as typeof themeMode;
              setThemeMode(mode);
              setTheme(resolveTheme(mode));
              writeThemeMode(mode);
            }}>
              <DropdownMenuRadioItem value="light">{zhCN.sidebar.lightMode}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">{zhCN.sidebar.darkMode}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">{zhCN.sidebar.followSystem}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {controller.projects === null || controller.activeProjectId === null ? (
          controller.projectsError || controller.loadError ? (
            <div className="project-error" role="alert" data-testid="projects-error">
              <p className="project-error-text">{controller.projectsError ?? controller.loadError}</p>
              {(controller.projectsError || controller.navigationRetryAvailable) && <button
                className="btn-ghost project-retry"
                data-testid="retry-projects"
                onClick={() => void (controller.projectsError ? controller.retryProjects() : controller.retryNavigation())}
              >
                {controller.projectsError ? zhCN.sidebar.retryProjects : zhCN.sidebar.retryNavigation}
              </button>}
            </div>
          ) : (
            <div className="empty-hint" data-testid="sessions-loading">
              {zhCN.sidebar.loading}
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
                <span className="new-session-label">{zhCN.sidebar.newSession}</span>
              </button>
            )}
            {controller.creationNotice && <small id="project-creation-notice" role="status">{controller.creationNotice}</small>}
            <div className="workbench-nav-body">
              {controller.navigationRetryAvailable && <button type="button" className="btn-ghost project-retry" data-testid="retry-navigation" onClick={() => void controller.retryNavigation()}>{zhCN.sidebar.retryNavigation}</button>}
              <SessionList
                key={controller.activeProjectId}
                loading={controller.sessions === null}
                projectContext={(searchToggle) => <ProjectSwitcher
                  projects={controller.projects ?? []}
                  activeId={controller.activeProjectId!}
                  onSelect={(id) => { closeMobileSidebar(); controller.selectProject(id); }}
                  onCreate={controller.createProject}
                >{searchToggle}</ProjectSwitcher>}
                  sessions={controller.sessions ?? []}
                  activeId={controller.activeSessionId}
                  onSelect={(id) => { closeMobileSidebar(); controller.selectSession(id); }}
                  onDelete={controller.deleteSession}
                  onRename={controller.renameSession}
                  onExport={controller.exportSession}
                />
            </div>
          </>
        )}
      </aside>

      <button
        ref={mobileMenuRef}
        type="button"
        className="workbench-mobile-menu"
        aria-label={zhCN.sidebar.openNavigation}
        aria-expanded={mobileSidebarOpen}
        onClick={() => { setDetailsCollapsed(true); setMobileSidebarOpen(true); }}
      >
        <Icon name="menu" />
      </button>
      {mobileSidebarOpen && <button type="button" className="workbench-drawer-backdrop" aria-label={zhCN.sidebar.closeNavigation} onClick={closeMobileSidebar} />}

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
        primaryAwaitingStart={controller.chatState.phase === "submitting"}
        loadError={controller.loadError}
        models={controller.models}
        thinkingLevels={controller.thinkingLevels}
        defaultModel={controller.defaultModel}
        defaultThinkingLevel={controller.defaultThinkingLevel}
        connected={controller.connected}
        stats={controller.chatState.stats}
        compaction={controller.chatState.compaction}
        modelOutput={controller.chatState.modelOutput}
        activeTools={!!controller.chatState.activeToolCallIds?.length}
        draftSource={controller.draftSource}
        draftScope={controller.draftScope}
        submission={controller.submitState}
        pendingControls={controller.pendingControls}
        controlQueue={controller.controlQueue}
        controlQueueLoading={controller.controlQueueLoading}
        controlQueueError={controller.controlQueueError}
        controlQueueOperations={controller.controlQueueOperations}
        refreshControlQueue={controller.refreshControlQueue}
        deleteControl={controller.deleteControl}
        promoteControl={controller.promoteControl}
        onDraftText={controller.setUnsentText}
        onDraftSettings={controller.setNewSessionSettings}
        onAddFile={controller.addUnsentFile}
        onRetryFile={controller.retryUnsentAttachment}
        onRemoveFile={controller.removeUnsentAttachment}
        onRetrySubmit={controller.retryFailedSubmission}
        onConfirmCreation={controller.confirmUnknownCreation}
        onSend={activeSession ? controller.sendMessage : controller.createSessionWithMessage}
        onAbort={controller.abort}
        onFollowUp={controller.followUp}
        onToggleTrace={() => { setMobileSidebarOpen(false); if (detailsCollapsed) setDetailsCollapsed(false); else closeInspector(); }}
        traceOpen={!detailsCollapsed}
        onConfigChange={(config) => {
          if (activeSession) void controller.changeSessionConfig(activeSession.id, config);
        }}
      />

      {/* 右侧 Inspector */}
      {activeSession && !detailsCollapsed && (
        <Inspector
          onClose={closeInspector}
          session={activeSession}
          entries={controller.eventLog}
          {...inspection}
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          onClearEvents={controller.clearEventLog}
        />
      )}

      {/* 拖拽手柄 */}
      {(!sidebarCollapsed || dragging === "sidebar") && (
        <div
          className={`resize-handle sidebar ${dragging === "sidebar" ? "dragging" : ""}`}
          onPointerDown={(event) => handlePointerDown("sidebar", event)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
    </main>
  );
}
