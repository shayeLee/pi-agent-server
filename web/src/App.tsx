import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./components/Icon.js";
import { useWebAppController } from "./hooks/useWebAppController.js";
import { SessionList } from "./components/SessionList.js";
import { ProjectSwitcher } from "./components/ProjectSwitcher.js";
import { Chat } from "./components/Chat.js";
import { Inspector } from "./components/Inspector.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Toaster } from "./components/Toaster.js";
import { SessionListSkeleton } from "./components/WorkspaceSkeleton.js";
import { useI18n } from "./i18n/I18nProvider.js";
import { useRouteSelectionSync } from "./routing/useRouteSelectionSync.js";
import { toastError } from "./lib/toast.js";
import { isMacPlatform } from "./components/Kbd.js";
import { cn } from "./lib/utils.js";

const SIDEBAR_DEFAULT = 264;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_RAIL = 56;
const DETAILS_DEFAULT = 380;
const DETAILS_MIN = 260;
const DETAILS_MAX = 500;

/** Agent harness 顶层布局；服务端状态与交互由 Web 专属 controller 提供。 */
export default function App() {
  const { t } = useI18n();
  const controller = useWebAppController();
  useRouteSelectionSync(controller);

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
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
  const [dragging, setDragging] = useState<"sidebar" | "details" | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const loadErrorShown = useRef<string | null>(null);

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

  useEffect(() => {
    if (!controller.loadError) {
      loadErrorShown.current = null;
      return;
    }
    if (loadErrorShown.current === controller.loadError) return;
    loadErrorShown.current = controller.loadError;
    toastError(controller.loadError);
  }, [controller.loadError]);

  const toggleTheme = useCallback(() => {
    themeOverridden.current = true;
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia?.("(max-width: 1179px)").matches) {
      setMobileSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((value) => !value);
  }, []);

  const toggleRunPanel = useCallback(() => {
    setMobileSidebarOpen(false);
    setDetailsCollapsed((value) => !value);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (mod && event.key === ".") {
        event.preventDefault();
        if (activeSession) toggleRunPanel();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (paletteOpen) return;
      if (document.querySelector('[role="dialog"][open], .select-menu[data-open="true"], .model-thinking-picker[data-open="true"]')) return;
      if (streaming && activeSession && !queued) controller.abort();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeSession, controller, paletteOpen, queued, streaming, toggleRunPanel, toggleSidebar]);

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

  const shellClass = cn(
    "app-shell relative grid h-dvh w-full overflow-hidden bg-background text-[13px] leading-snug text-foreground",
    "grid-cols-[var(--layout-sidebar-width)_minmax(0,1fr)_var(--layout-inspector-width)]",
    "max-[1439px]:grid-cols-[var(--layout-sidebar-width)_minmax(0,1fr)_0px]",
    "max-[1179px]:block",
    mobileSidebarOpen && "mobile-sidebar-open",
    sidebarCollapsed && "sidebar-collapsed",
    detailsCollapsed && "details-collapsed",
    dragging && "dragging select-none",
  );

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
      <aside className={cn(
        "sidebar workbench-sidebar flex h-full min-w-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        sidebarCollapsed && "items-center",
        "max-[1179px]:fixed max-[1179px]:inset-y-0 max-[1179px]:left-0 max-[1179px]:z-[92] max-[1179px]:h-dvh max-[1179px]:w-[min(320px,85vw)] max-[1179px]:shadow-lg",
        mobileSidebarOpen
          ? "max-[1179px]:visible max-[1179px]:translate-x-0 max-[1179px]:items-stretch"
          : "max-[1179px]:invisible max-[1179px]:-translate-x-[102%]",
      )} data-testid="sidebar">
        <div className={cn("sidebar-header workbench-sidebar-header flex h-12 shrink-0 items-center justify-between gap-2 px-4", sidebarCollapsed && "w-full justify-center px-1")}>
          <div className="brand workbench-brand flex min-w-0 items-center gap-2">
            <span className="brand-mark workbench-brand-mark grid size-6 place-items-center rounded-md bg-primary text-[12px] font-semibold text-primary-foreground" aria-hidden="true">π</span>
            <span className={cn("brand-text workbench-brand-title truncate font-mono text-[12px] font-semibold text-muted-foreground", sidebarCollapsed && "hidden max-[1179px]:inline")}>{t("app.brand")}</span>
          </div>
          <button
            className="btn-ghost btn-icon workbench-sidebar-toggle grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent"
            data-testid="toggle-sidebar"
            onClick={() => {
              if (window.matchMedia?.("(max-width: 1179px)").matches) closeMobileSidebar();
              else setSidebarCollapsed((value) => !value);
            }}
            title={sidebarCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
            aria-label={sidebarCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        {controller.projects === null || controller.activeProjectId === null ? (
          controller.projectsError ? (
            <div className="project-error mx-4 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[12px]" role="alert" data-testid="projects-error">
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
            <SessionListSkeleton />
          )
        ) : (
          <>
            {controller.sessions !== null && (
              <button
                className={cn(
                  "new-session workbench-new-session mx-4 mb-2 flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-[13px] font-medium hover:bg-accent",
                  sidebarCollapsed && "mx-auto size-10 justify-center px-0",
                  sidebarCollapsed && "max-[1179px]:mx-4 max-[1179px]:h-9 max-[1179px]:w-[calc(100%-2rem)] max-[1179px]:justify-start max-[1179px]:px-3",
                )}
                data-testid="new-session"
                disabled={!canCreateSession}
                title={controller.creationNotice ?? undefined}
                aria-describedby={controller.creationNotice ? "project-creation-notice" : undefined}
                onClick={() => { closeMobileSidebar(); controller.createSession(); }}
              >
                <Icon name="plus" className="new-session-icon text-primary" />
                <span className={cn("new-session-label", sidebarCollapsed && "hidden max-[1179px]:inline")}>{t("nav.newSession")}</span>
              </button>
            )}
            {controller.creationNotice && <small id="project-creation-notice" role="status">{controller.creationNotice}</small>}
            <div className={cn("workbench-nav-body flex min-h-0 flex-1 flex-col overflow-hidden", sidebarCollapsed && "hidden max-[1179px]:flex")}>
              <div className="workbench-section-header px-4 pb-2 pt-1 text-[12px] font-semibold text-muted-foreground">{t("nav.projectsSection")}</div>
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
                  <div className="workbench-section-header px-4 pb-2 pt-1 text-[12px] font-semibold text-muted-foreground">{t("nav.sessionsSection")}</div>
                  <SessionListSkeleton />
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
        <div className={cn("sidebar-footer mt-auto w-full shrink-0 border-t border-sidebar-border px-4 py-2", sidebarCollapsed && "px-1")}>
          <button type="button" className={cn("theme-toggle flex h-9 w-full items-center gap-2 rounded-md px-2 text-[13px] text-foreground hover:bg-sidebar-accent", sidebarCollapsed && "justify-center px-0")} data-testid="theme-toggle"
            aria-label={theme === "dark" ? t("theme.toggleToLight") : t("theme.toggleToDark")}
            title={theme === "dark" ? t("theme.toggleToLight") : t("theme.toggleToDark")}
            onClick={toggleTheme}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
            <span className={cn(sidebarCollapsed && "hidden max-[1179px]:inline")}>{theme === "dark" ? t("theme.modeLight") : t("theme.modeDark")}</span>
          </button>
        </div>
      </aside>

      <button
        ref={mobileMenuRef}
        type="button"
        className={cn("workbench-mobile-menu fixed left-2 top-2 z-30 size-8 place-items-center rounded-md border border-border bg-background max-[640px]:size-[44px]", mobileSidebarOpen ? "hidden" : "hidden max-[1179px]:inline-flex")}
        aria-label={t("mobile.openNav")}
        aria-expanded={mobileSidebarOpen}
        onClick={() => { setDetailsCollapsed(true); setMobileSidebarOpen(true); }}
      >
        <Icon name="menu" />
      </button>
      {mobileSidebarOpen && <button type="button" className="workbench-drawer-backdrop fixed inset-0 z-[80] hidden bg-black/45 max-[1179px]:block" aria-label={t("mobile.closeNav")} onClick={closeMobileSidebar} />}

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
        compaction={controller.chatState.compaction}
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
      {activeSession && !detailsCollapsed && <button type="button" className="workbench-inspector-backdrop fixed inset-0 z-[84] hidden bg-black/45 max-[1439px]:block" aria-label={t("inspector.close")} onClick={closeInspector} />}
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
          className={cn("resize-handle sidebar absolute inset-y-0 z-20 w-[5px] -ml-0.5 cursor-col-resize touch-none max-[1179px]:hidden", dragging === "sidebar" && "dragging")}
          style={{ left: "var(--layout-sidebar-width)" }}
          onPointerDown={(event) => handlePointerDown("sidebar", event)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
      {!detailsCollapsed && (
        <div
          className={cn("resize-handle details absolute inset-y-0 z-20 w-[5px] cursor-col-resize touch-none max-[1439px]:hidden", dragging === "details" && "dragging")}
          style={{ right: "var(--layout-inspector-width)" }}
          onPointerDown={(event) => handlePointerDown("details", event)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={controller.sessions}
        projects={controller.projects}
        activeProjectId={controller.activeProjectId}
        activeSessionId={controller.activeSessionId}
        canCreateSession={canCreateSession}
        hasSession={activeSession !== null}
        theme={theme}
        onNewSession={() => { closeMobileSidebar(); controller.createSession(); }}
        onSelectSession={(id) => { closeMobileSidebar(); controller.selectSession(id); }}
        onSelectProject={(id) => { closeMobileSidebar(); controller.selectProject(id); }}
        onToggleSidebar={toggleSidebar}
        onToggleRunPanel={toggleRunPanel}
        onToggleTheme={toggleTheme}
      />
      <Toaster />
    </main>
  );
}
