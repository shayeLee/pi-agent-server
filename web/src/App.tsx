import { SubagentChat, SubagentList } from "./components/Subagents.js";
import { readRoute } from "./routing.js";
import { readRecentSelection } from "./recent-selection.js";
import { useSubagents } from "./hooks/useSubagents.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readThemeMode, resolveTheme, writeThemeMode, type ThemeMode } from "./theme-preference.js";
import { Icon } from "./components/Icon.js";
import { useWebAppController } from "./hooks/useWebAppController.js";
import { SessionList } from "./components/SessionList.js";
import { ProjectSwitcher } from "./components/ProjectSwitcher.js";
import { useProjectMcp } from "./components/ProjectMcpPanel.js";
import { useProviderAuth } from "./components/ProviderAuthPanel.js";
import { useAgentSettings } from "./components/AgentSettingsPanel.js";
import { useProjectTrust } from "./components/ProjectTrustPanel.js";
import type { TraceNavigation } from "./components/step-navigation.js";
import { Chat } from "./components/Chat.js";
import { Inspector, type InspectorTab } from "./components/Inspector.js";
import { useSessionInspection } from "./hooks/useSessionInspection.js";
import { zhCN } from "./i18n/zh-CN.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "./components/ui/dropdown-menu.js";
import { CommandPalette, ShortcutHelp, type Command } from "./components/CommandPalette.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";

const SIDEBAR_DEFAULT = 272;
/**
 * From this window width the trace opens with a session: sidebar 272 + trace 380 leave the
 * conversation ~850px, a ~650px content column, still above the compact ledger (640px container).
 * Narrower laptops start with it closed.
 */
export const TRACE_DEFAULT_MIN_WIDTH = 1500;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 360;
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
  // The trace opens by default where the conversation still reads comfortably beside it.
  // A manual open/close holds for this page.
  const traceFits = () => window.matchMedia?.(`(min-width: ${TRACE_DEFAULT_MIN_WIDTH}px)`).matches ?? false;
  const traceWanted = useRef(true);
  // A session is about to open (session URL, or the root restoring the last selection): reserve the
  // trace column from the first frame, so it does not appear later and shift the centred column.
  // Route resolution rewrites the URL / clears the selection when that session is not available.
  const sessionExpected = () => {
    const route = readRoute();
    return route === "root" ? !!readRecentSelection()?.sessionId : typeof route === "object" && route.sessionId !== null;
  };
  const [detailsCollapsed, setDetailsCollapsed] = useState(() => !(traceFits() && sessionExpected()));
  const shellRef = useRef<HTMLElement>(null);
  const [traceNavigation, setTraceNavigation] = useState<TraceNavigation | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("subagents");
  useEffect(() => { setTraceNavigation(null); }, [detailsCollapsed, inspectorTab, controller.activeSessionId]);
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
  // Chosen but not loaded yet (id set, list pending), or still being resolved from the URL / last selection.
  // A load error (e.g. a transient failure that keeps the URL for retry) ends the wait: no blank column.
  const sessionPending = !activeSession && !controller.loadError && (controller.activeSessionId !== null || sessionExpected());
  useEffect(() => {
    setDetailsCollapsed(!(activeSession || sessionPending) || !traceWanted.current || !traceFits());
  }, [activeSession?.id, sessionPending]);
  const [childSelection, setChildSelection] = useState<{ sessionId: string; runId: string } | null>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("pi:selected-subagent") ?? "null");
      return saved && typeof saved.sessionId === "string" && typeof saved.runId === "string" ? saved : null;
    } catch { return null; }
  });
  useEffect(() => { try { sessionStorage.setItem("pi:selected-subagent", JSON.stringify(childSelection)); } catch { /* Storage is optional. */ } }, [childSelection]);
  const selectedChild = childSelection?.sessionId === activeSession?.id ? childSelection?.runId ?? null : null;
  // A live parent request may start children, so the list keeps polling until it settles.
  const subagents = useSubagents(controller.api, activeSession?.id ?? null, { runId: selectedChild,
    visible: !detailsCollapsed && inspectorTab === "subagents", live: controller.chatState.phase === "streaming", signal: controller.subagentsPosition });
  const liveSubagents = subagents.live;
  const inspection = useSessionInspection({ api: controller.api, sessionId: activeSession?.id ?? null,
    visible: !detailsCollapsed && !mobileSidebarOpen, activeTab: inspectorTab,
    refreshKey: controller.inspectionRefreshKey, stepsPosition: controller.stepsPosition });
  // The nested chat/inspector columns cannot share a CSS grid row. Measure only
  // the natural chat header (including its border); never feed this height back
  // into the chat, so wrapping and resize can also shrink it without a loop.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const header = shell?.querySelector<HTMLElement>(selectedChild ? '[data-testid="child-chat-header"]' : '[data-testid="chat-header"]');
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
  }, [activeSession?.id, detailsCollapsed, selectedChild]);
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

  const toggleInspector = () => {
    if (detailsCollapsed) { traceWanted.current = true; setMobileSidebarOpen(false); setDetailsCollapsed(false); }
    else closeInspector();
  };

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState(0);
  const toggleSidebar = () => {
    if (window.matchMedia?.("(max-width: 1179px)").matches) setMobileSidebarOpen(open => !open);
    else setSidebarCollapsed(value => !value);
  };
  const applyThemeMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    setTheme(resolveTheme(mode));
    writeThemeMode(mode);
  };
  const visibleChat = () => document.querySelector<HTMLElement>('.chat:not([hidden])');
  const focusComposer = () => visibleChat()?.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus();
  // A new session is for typing; touch screens skip this so the keyboard does not jump up uninvited.
  const newSession = () => {
    if (!canCreateSession) return;
    closeMobileSidebar();
    controller.createSession();
    if (!window.matchMedia?.("(pointer: coarse)").matches) requestAnimationFrame(focusComposer);
  };
  const openSearch = () => {
    if (window.matchMedia?.("(max-width: 1179px)").matches) setMobileSidebarOpen(true);
    else setSidebarCollapsed(false);
    setSearchRequest(value => value + 1);
  };
  const shortcutHandlers = {
    palette: () => setPaletteOpen(true),
    help: () => setHelpOpen(true),
    newSession,
    search: openSearch,
    toggleTrace: () => { if (activeSession) toggleInspector(); },
    toggleSidebar,
    focusComposer,
    toggleWork: () => Array.from(visibleChat()?.querySelectorAll<HTMLButtonElement>(".work-header") ?? []).at(-1)?.click(),
    latest: () => {
      const chat = visibleChat();
      const latest = chat?.querySelector<HTMLButtonElement>(".chat-latest");
      if (latest) latest.click();
      else { const body = chat?.querySelector<HTMLElement>(".chat-body"); if (body) body.scrollTop = body.scrollHeight; }
    },
  };
  useGlobalShortcuts(shortcutHandlers);
  const projectMcp = useProjectMcp({ api: controller.api, projectId: controller.activeProjectId,
    projectName: controller.projects?.find(project => project.id === controller.activeProjectId)?.name ?? zhCN.project.defaultProject });
  const providerAuth = useProviderAuth({ api: controller.api });
  const activeProjectName = controller.projects?.find(project => project.id === controller.activeProjectId)?.name ?? zhCN.project.defaultProject;
  // 信任改了：本项目的 MCP 列表和各模型的默认思考档位都可能变。
  const projectTrust = useProjectTrust({ api: controller.api, projectId: controller.activeProjectId, projectName: activeProjectName,
    onChanged: () => { projectMcp.refresh(); void controller.refreshModels(); } });
  const agentSettings = useAgentSettings({ api: controller.api, models: controller.models, projectId: controller.activeProjectId, onSaved: () => void controller.refreshModels() });
  const themeLabels: Record<ThemeMode, string> = { light: zhCN.sidebar.lightMode, dark: zhCN.sidebar.darkMode, system: zhCN.sidebar.followSystem };
  const commands: Command[] = [
    ...(canCreateSession ? [{ id: "new", group: zhCN.palette.groupActions, label: zhCN.sidebar.newSession, hint: "N", run: newSession }] : []),
    { id: "search", group: zhCN.palette.groupActions, label: zhCN.palette.searchSessions, hint: "/", run: openSearch },
    ...(activeSession ? [{ id: "trace", group: zhCN.palette.groupView, label: detailsCollapsed ? zhCN.header.openTrace : zhCN.header.closeTrace, hint: "⌘I", run: toggleInspector }] : []),
    { id: "sidebar", group: zhCN.palette.groupView, label: zhCN.palette.toggleSidebar, hint: "⌘B", run: toggleSidebar },
    ...(["light", "dark", "system"] as ThemeMode[]).map(mode => ({ id: `theme-${mode}`, group: zhCN.palette.groupTheme,
      label: `${zhCN.sidebar.themeMenu}：${themeLabels[mode]}${mode === themeMode ? " ✓" : ""}`, run: () => applyThemeMode(mode) })),
    // Same items, same order as the Settings menu.
    ...(agentSettings.available ? [{ id: "agent-settings", group: zhCN.palette.groupSettings, label: zhCN.agentSettings.open, run: agentSettings.openPanel }] : []),
    ...(projectMcp.available ? [{ id: "mcp", group: zhCN.palette.groupSettings, label: zhCN.projectMcp.open, run: projectMcp.openPanel }] : []),
    ...(projectTrust.available ? [{ id: "project-trust", group: zhCN.palette.groupSettings, label: zhCN.projectTrust.open, run: projectTrust.openPanel }] : []),
    ...(providerAuth.available ? [{ id: "provider-auth", group: zhCN.palette.groupSettings, label: zhCN.providerAuth.open, run: providerAuth.openPanel }] : []),
    ...(activeSession ? [{ id: "copy-id", group: zhCN.palette.groupActions, label: zhCN.palette.copySessionId, run: () => { void navigator.clipboard?.writeText(activeSession.id); } }] : []),
    ...(controller.projects ?? []).map(project => ({ id: `project-${project.id}`, group: zhCN.palette.groupProjects,
      label: `${project.name}${project.id === controller.activeProjectId ? " ✓" : ""}`, run: () => controller.selectProject(project.id) })),
    ...(controller.sessions ?? []).slice(0, 50).map(session => ({ id: `session-${session.id}`, group: zhCN.palette.groupSessions,
      label: session.title || session.firstPrompt || zhCN.palette.untitled, run: () => controller.selectSession(session.id) })),
    { id: "help", group: zhCN.palette.groupHelp, label: zhCN.palette.shortcuts, hint: "?", run: () => setHelpOpen(true) },
  ];

  const closeInspector = () => {
    traceWanted.current = false;
    setDetailsCollapsed(true);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid="child-subagents-toggle"], .chat:not([hidden]) [data-testid="trace-tab"]')?.focus(), 0);
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
      if (event.defaultPrevented || document.querySelector('[data-ui="dropdown-menu"][data-state="open"], .interactive-tooltip-content[data-state="open"]')) return;
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

  // The companion talks about where you left off in this project, not elsewhere.
  const latest = (controller.sessions ?? []).filter(item => item.projectId === controller.activeProjectId).reduce<NonNullable<typeof controller.sessions>[number] | null>((best, item) => !best || item.updatedAt > best.updatedAt ? item : best, null);
  const recentSession = controller.sessions === null ? undefined : latest ? { title: latest.title || latest.firstPrompt || "", updatedAt: latest.updatedAt } : null;

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
            <span className="brand-text workbench-brand-title ledger-brand" aria-label="pi-agent-server">pi<span aria-hidden="true">/</span>agent</span>
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
            <button type="button" className="settings-toggle" data-testid="settings-toggle" aria-label={zhCN.sidebar.settings} title={zhCN.sidebar.settings}>
              <Icon name="settings" /><span>{zhCN.sidebar.settings}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" aria-label={zhCN.sidebar.settings}>
            <DropdownMenuLabel className="settings-menu-label">{zhCN.sidebar.themeMenu}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={themeMode} onValueChange={(value) => applyThemeMode(value as ThemeMode)}>
              <DropdownMenuRadioItem value="light">{zhCN.sidebar.lightMode}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">{zhCN.sidebar.darkMode}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">{zhCN.sidebar.followSystem}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {(projectMcp.available || projectTrust.available || providerAuth.available || agentSettings.available) && <DropdownMenuSeparator />}
            {agentSettings.available && <DropdownMenuItem data-testid="agent-settings-open" onSelect={agentSettings.openPanel}>{zhCN.agentSettings.open}</DropdownMenuItem>}
            {projectMcp.available && <DropdownMenuItem data-testid="project-mcp-open" onSelect={projectMcp.openPanel}>{zhCN.projectMcp.open}</DropdownMenuItem>}
            {projectTrust.available && <DropdownMenuItem data-testid="project-trust-open" onSelect={projectTrust.openPanel}>{zhCN.projectTrust.open}</DropdownMenuItem>}
            {providerAuth.available && <DropdownMenuItem data-testid="provider-auth-open" onSelect={providerAuth.openPanel}>{zhCN.providerAuth.open}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        {projectMcp.dialog}
        {projectTrust.dialog}
        {providerAuth.dialog}
        {agentSettings.dialog}
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
                onClick={newSession}
              >
                <Icon name="plus" className="new-session-icon" />
                <span className="new-session-label">{zhCN.sidebar.newSession}</span>
                <kbd className="new-session-kbd" aria-hidden="true">N</kbd>
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
                  runningId={streaming ? controller.activeSessionId : null}
                  searchRequest={searchRequest}
                />
              <p className="sidebar-hints" aria-hidden="true">{zhCN.palette.sidebarHints}</p>
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
      {activeSession && selectedChild && <SubagentChat {...subagents} title={activeSession.title || activeSession.firstPrompt || "主会话"}
        inspectorOpen={!detailsCollapsed} onBack={() => setChildSelection(null)} onToggleInspector={toggleInspector}
        canWrite={controller.canWrite} onSteer={(runId, text) => controller.api.steerSubagent(activeSession.id, runId, text)} />}
      <Chat
        hidden={!!selectedChild}
        session={activeSession}
        projects={controller.projects}
        activeProjectId={controller.activeProjectId}
        recentSession={recentSession}
        onSelectProject={controller.selectProject}
        canCreateSession={canCreateSession}
        canWrite={controller.canWrite && (activeSession !== null || controller.projectAllowsCreation)}
        timeline={controller.chatState.timeline}
        historyLoading={controller.historyLoading}
        historyNotice={controller.historyNotice}
        streaming={streaming}
        queued={queued}
        phase={controller.chatState.phase}
        liveSubagents={liveSubagents}
        onOpenSubagent={runId => { if (activeSession) setChildSelection({ sessionId: activeSession.id, runId }); }}
        runFailed={Boolean(controller.chatState.error)}
        primaryAwaitingStart={controller.chatState.phase === "submitting"}
        loadError={controller.loadError}
        models={controller.models}
        thinkingLevels={controller.thinkingLevels}
        defaultModel={controller.defaultModel}
        defaultThinkingLevel={controller.defaultThinkingLevel}
        modelThinkingLevels={controller.modelThinkingLevels}
        connection={controller.connection}
        stats={controller.chatState.stats}
        compaction={controller.chatState.compaction}
        commandPrompt={controller.chatState.commandPrompt}
        onAnswerCommandPrompt={controller.answerCommandPrompt}
        modelOutput={controller.chatState.modelOutput}
        runProgress={controller.chatState.runProgress}
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
        loadCommands={controller.loadCommands}
        companionGreeting={controller.companionGreeting}
        companionPersona={controller.companionPersona}
        searchFiles={controller.searchFiles}
        onRunCommand={controller.runCommand}
        onToggleTrace={toggleInspector}
        traceOpen={!detailsCollapsed}
        onNavigateTurn={timelineId => {
          if (activeSession && !detailsCollapsed && inspectorTab === 'steps') {
            setTraceNavigation(previous => ({sessionId:activeSession.id, timelineId, sequence:(previous?.sequence ?? 0) + 1}));
          }
        }}
        onConfigChange={(config) => {
          if (activeSession) void controller.changeSessionConfig(activeSession.id, config);
        }}
      />

      {/* 右侧 Inspector */}
      {/* Reserved while the session loads: same frame as the trace, so nothing shifts when it fills in. */}
      {!activeSession && !detailsCollapsed && <aside className="inspector inspector-placeholder" data-testid="inspector-placeholder" aria-hidden="true" />}
      {activeSession && !detailsCollapsed && (
        <Inspector
          subagentCount={subagents.runs.length}
          subagents={<SubagentList {...subagents} selected={selectedChild} onSelect={runId => {
            setChildSelection({ sessionId: activeSession.id, runId });
            if (window.innerWidth < 1180) setDetailsCollapsed(true);
          }} />}
          onClose={closeInspector}
          session={activeSession}
          entries={controller.eventLog}
          {...inspection}
          navigation={traceNavigation}
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
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </main>
  );
}
