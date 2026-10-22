import { zhCN } from "../i18n/zh-CN.js";
import { formatTime } from "../i18n/format.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DEFAULT_PROJECT_ID, ApiClient, ApiError, createChatStore, ownsSseEvent } from "pi-agent-server/client";
import type { AccessCapabilities, ChatStore, CompanionGreetingInput, CompanionPersonaRecord, ModelInfo, Project, SessionCommandInput, SessionRecord, SseEvent, UsageSnapshot } from "pi-agent-server/client";
import type { EventLogEntry } from "../types.js";
import { EMPTY_MESSAGE, type SubmissionState, type SubmitOutcome, type SubmitSnapshot, type UnsentMessage } from "../attachment-state.js";

import { useSessionStream, type SessionConnection } from "./useSessionStream.js";
import { useSessionControls } from "./useSessionControls.js";
import { createDraftAttachmentActions } from "./draft-attachments.js";
import { createDraftStore } from "../draft-store.js";
import { clearRecentSelection, readRecentSelection, writeRecentSelection } from "../recent-selection.js";
import { listenRoute, readRoute, writeRoute, type RouteInput } from "../routing.js";

/** Web 页面专属服务端状态适配层：封装 API 编排与 SSE 聊天状态。 */
export function useWebAppController() {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [access, setAccess] = useState<AccessCapabilities | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  // Explicitly created, still-empty projects remain selectable in this browser.
  const draftProjectsRef = useRef(new Map<string, Project>());
  // 项目列表加载前不选项目；默认项目完全由服务端 isDefault 字段推导。
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelInfo | null>(null);
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState("");
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationRetryAvailable, setNavigationRetryAvailable] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [connection, setConnection] = useState<SessionConnection>("idle");
  const connected = connection === "open";
  const [inspectionRefreshKey, setInspectionRefreshKey] = useState(0);
  /** Latest steps position pushed by the server (steps_changed); the Steps tab reads on change. */
  const [stepsPosition, setStepsPosition] = useState<string | null>(null);
  /** Latest subagents_changed position pushed by the server; the subagent feed reads on change. */
  const [subagentsPosition, setSubagentsPosition] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [historyReadySessionIds, setHistoryReadySessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const draftStore = useMemo(() => createDraftStore(), []);
  const [submitStates, setSubmitStates] = useState<Record<string, SubmissionState>>({});
  const submitStatesRef = useRef<typeof submitStates>({});
  const submittingScopesRef = useRef(new Set<string>());
  const newlyCreatedIdsRef = useRef(new Set<string>());
  const imageInsertionRef = useRef(new Map<string, number>());
  const firstPromptsRef = useRef(new Map<string, string>());
  // null/undefined DTO summaries mean unknown, never proof of empty history.
  const emptyHistoryIdsRef = useRef(new Set<string>());
  const explicitTitlesRef = useRef(new Map<string, string>());
  // Restore is invalidated by edits too; creation ownership changes only on navigation.
  const selectionRevisionRef = useRef(0);
  const navigationGenerationRef = useRef(0);
  const [navigationGeneration, setNavigationGeneration] = useState(0);
  function advanceNavigation(): number {
    const generation = ++navigationGenerationRef.current;
    setNavigationGeneration(generation);
    return generation;
  }
  function clearMatchingRecent(projectId: string, sessionId?: string | null): void {
    const recent = readRecentSelection();
    if (recent?.projectId === projectId && (sessionId === undefined || recent.sessionId === sessionId)) clearRecentSelection();
  }
  const restoreAttemptedRef = useRef(false);
  const projectsRef = useRef<Project[] | null>(null);
  const projectsPromiseRef = useRef<Promise<void> | null>(null);
  function rememberSelection(projectId: string, sessionId: string | null, mode: "push" | "replace" = "push"): void {
    advanceNavigation();
    ++selectionRevisionRef.current;
    writeRecentSelection(projectId, sessionId);
    writeRoute({ projectId, sessionId }, mode);
  }

  function mergeTitleMetadata(record: SessionRecord, protectExplicitTitle = false): SessionRecord {
    // Persisted summaries supersede local accepted-send fallbacks.
    if (record.firstPrompt != null) firstPromptsRef.current.set(record.id, record.firstPrompt);
    return { ...record, firstPrompt: firstPromptsRef.current.get(record.id) ?? record.firstPrompt,
      title: protectExplicitTitle ? explicitTitlesRef.current.get(record.id) ?? record.title : record.title };
  }
  function rememberAcceptedPrompt(sessionId: string, prompt: string): void {
    if (!emptyHistoryIdsRef.current.delete(sessionId)) return;
    rememberFirstPrompt(sessionId, prompt);
  }
  function rememberFirstPrompt(sessionId: string, prompt: string | null): void {
    if (prompt === null || firstPromptsRef.current.has(sessionId)) return;
    firstPromptsRef.current.set(sessionId, prompt);
    setSessions((previous) => previous?.map((row) => row.id === sessionId ? mergeTitleMetadata(row) : row) ?? null);
  }

  function projectAcceptedImages(store: ChatStore, snapshot: SubmitSnapshot): void {
    const current = store.getState().timeline;
    const id = `confirmed-${snapshot.requestId}`;
    if (current.some((item) => item.id === id)) return;
    const index = imageInsertionRef.current.get(snapshot.requestId) ?? current.length;
    store.restoreHistory([...current.slice(0, index), { kind: "message", id, role: "user",
      text: snapshot.text || (snapshot.fileIds.length ? zhCN.errors.attachmentCount(snapshot.fileIds.length) : ""),
      images: snapshot.images, streaming: false }, ...current.slice(index)]);
    imageInsertionRef.current.delete(snapshot.requestId);
  }

  const historyReadySessionIdsRef = useRef(new Set<string>());
  const chatStoresRef = useRef(new Map<string, ChatStore>());
  // A cached timeline must resume from its consumed cursor, not a newer export cursor:
  // events missed while deselected also close the old owner before a host follow-up starts.
  const eventCursorsRef = useRef(new Map<string, number>());
  const emptyChatStore = useMemo(() => createChatStore(), []);
  function getChatStore(sessionId: string): ChatStore {
    let store = chatStoresRef.current.get(sessionId);
    if (!store) {
      store = createChatStore();
      chatStoresRef.current.set(sessionId, store);
    }
    return store;
  }
  const currentScope = activeSessionId ? `session:${activeSessionId}` : `new:${activeProjectId ?? "none"}`;
  const submitState = submitStates[currentScope] ?? null;

  function updateUnsent(scope: string, change: (previous: UnsentMessage) => UnsentMessage): void {
    draftStore.update(scope, change);
  }
  function updateSubmitState(scope: string, value: SubmissionState | null): void {
    const next = { ...submitStatesRef.current };
    if (value) next[scope] = value;
    else delete next[scope];
    submitStatesRef.current = next;
    setSubmitStates(next);
  }
  const draftTextRevisionsRef = useRef(new Map<string, number>());
  function setUnsentText(text: string): void {
    ++selectionRevisionRef.current;
    draftTextRevisionsRef.current.set(currentScope, (draftTextRevisionsRef.current.get(currentScope) ?? 0) + 1);
    updateUnsent(currentScope, (previous) => ({ ...previous, text }));
  }
  function setNewSessionSettings(config: UnsentMessage["settings"]): void {
    ++selectionRevisionRef.current;
    updateUnsent(currentScope, (previous) => ({ ...previous, settings: { ...previous.settings, ...config } }));
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
  const rawChatState = useSyncExternalStore(subscribeChat, getChatSnapshot, getChatSnapshot);
  const [usageSnapshots, setUsageSnapshots] = useState<Record<string, UsageSnapshot | undefined>>({});
  const [invalidContexts, setInvalidContexts] = useState<ReadonlySet<string>>(new Set());
  const usageRevisionRef = useRef(new Map<string, number>());
  function invalidateContext(id: string): void {
    usageRevisionRef.current.set(id, (usageRevisionRef.current.get(id) ?? 0) + 1);
    setInvalidContexts(previous => new Set([...previous, id]));
    setUsageSnapshots(previous => ({ ...previous, [id]: undefined }));
  }
  const snapshot = activeSessionId ? usageSnapshots[activeSessionId] : undefined;
  const visibleStats = snapshot ? {
    durationMs: NaN, ttftMs: NaN, promptTokens: null, completionTokens: null, totalTokens: null,
    ...snapshot,
    execution: rawChatState.stats?.execution ?? snapshot.execution,
  } : rawChatState.stats;
  const chatState = { ...rawChatState, stats: visibleStats && activeSessionId && invalidContexts.has(activeSessionId)
    ? { ...visibleStats, context: null } : visibleStats };

  const activeSessionIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // Receipts live only as long as their HTTP send, independently of navigation/cursors.
  // A pending promise already owns this receipt; no historical confirmation cache is needed.
  const inflightReceiptsRef = useRef(new Map<string, { sessionId: string; accepted: boolean }>());
  const eventSeqRef = useRef(0);
  // 快速切换项目时，旧会话请求的响应/错误不得覆盖当前项目状态。
  const sessionsRequestSeqRef = useRef(0);
  const api = useMemo(() => new ApiClient({ baseUrl: "" }), []);
  const { addUnsentFile, retryUnsentAttachment, removeUnsentAttachment } = createDraftAttachmentActions({
    api, draftStore, currentScope,
    getProjectId: () => {
      const session = activeSessionId ? sessions?.find((record) => record.id === activeSessionId) : null;
      return session?.projectId ?? activeProjectId;
    },
    invalidateRestore: () => {
      ++selectionRevisionRef.current;
    },
  });

  async function refreshSessions(projectId: string): Promise<
    { kind: "ok"; rows: SessionRecord[] } | { kind: "stale" } |
    { kind: "unavailable" | "transient"; error: string }
  > {
    const seq = ++sessionsRequestSeqRef.current;
    const titlesAtStart = new Map(explicitTitlesRef.current);
    try {
      setLoadError(null);
      const list = await api.listSessionsByProject(projectId);
      if (seq !== sessionsRequestSeqRef.current || activeProjectIdRef.current !== projectId) return { kind: "stale" };
      setSessions(list.map((row) => mergeTitleMetadata(row,
        titlesAtStart.get(row.id) !== explicitTitlesRef.current.get(row.id))));
      return { kind: "ok", rows: list };
    } catch (err) {
      if (seq !== sessionsRequestSeqRef.current || activeProjectIdRef.current !== projectId) return { kind: "stale" };
      return { kind: err instanceof ApiError && (err.status === 403 || err.status === 404) ? "unavailable" : "transient",
        error: err instanceof Error ? err.message : String(err) };
    }
  }

  function refreshProjects(metadataOnly = false): Promise<void> {
    if (projectsPromiseRef.current) return projectsPromiseRef.current;
    const promise = loadProjects(metadataOnly).finally(() => {
      if (projectsPromiseRef.current === promise) projectsPromiseRef.current = null;
    });
    projectsPromiseRef.current = promise;
    return promise;
  }

  async function refreshCreatedProjects(): Promise<void> {
    // An already-running list may have read before the session was persisted.
    // Wait for it, then fetch real metadata; the session DTO is not a project DTO.
    await projectsPromiseRef.current;
    await refreshProjects(true);
  }

  async function loadProjects(metadataOnly = false): Promise<void> {
    if (!api) return;
    const revision = selectionRevisionRef.current;
    const generation = navigationGenerationRef.current;
    const route = readRoute();
    try {
      const list = await api.listProjects();
      for (const project of list) draftProjectsRef.current.delete(project.id);
      list.push(...draftProjectsRef.current.values());
      projectsRef.current = list;
      if (metadataOnly) {
        // Creation invalidates owner-visible metadata, not the user's navigation.
        setProjects(list);
        setProjectsError(null);
        return;
      }
      // Existing owners may receive metadata refreshes after navigation. Only
      // unresolved startup must withhold it to keep the editor loading gate.
      if (activeProjectIdRef.current !== null) setProjects(list);
      setProjectsError(null);
      if (generation !== navigationGenerationRef.current) return;
      if (!restoreAttemptedRef.current) {
        restoreAttemptedRef.current = true;
        await resolveRoute(route, generation, revision);
      } else if (typeof route === "object" && route.sessionId !== null && route.sessionId !== activeSessionIdRef.current) {
        await resolveRoute(route, generation, selectionRevisionRef.current);
      } else if (!list.some(project => project.id === activeProjectIdRef.current)) {
        await resolveRoute(route === "root" ? "root" : "invalid", generation, selectionRevisionRef.current);
      } else {
        setProjects(list);
      }
    } catch (err) {
      // A post-create metadata failure must not invalidate an accepted send,
      // its draft/snapshot, recent selection, or another project's session state.
      if (metadataOnly) return;
      if (revision === selectionRevisionRef.current && err instanceof ApiError && (err.status === 403 || err.status === 404)) clearRecentSelection();
      // Startup is shared across navigation: a failed initialization belongs to
      // the latest waiter too, even if popstate invalidated the initiating revision.
      if (projectsRef.current !== null && revision !== selectionRevisionRef.current) return;
      ++sessionsRequestSeqRef.current;
      setProjectsError(
        zhCN.errors.loadProjects(err instanceof Error ? err.message : String(err)),
      );
      // 默认项目未能确定时，不创建会话或查询特定项目会话。
      setActiveProjectId(null);
      setSessions(null);
      setActiveSessionId(null);
    }
  }

  // URL reads and state commits share one generation; no state-to-URL effect.
  async function resolveRoute(input: RouteInput, generation: number, revision: number): Promise<void> {
    const list = projectsRef.current;
    if (!list || generation !== navigationGenerationRef.current) return;
    setNavigationRetryAvailable(false);
    // The root entry retains the legacy first-send target even when the API
    // filters an empty default project. Explicit URLs need visible metadata.
    const fallback = list.find(project => project.isDefault)?.id ?? list[0]?.id ??
      (input === "root" ? DEFAULT_PROJECT_ID : null);
    const recent = input === "root" ? readRecentSelection() : null;
    const target = typeof input === "object" ? input : recent;
    let projectId = target?.projectId ?? fallback;
    let sessionId = target?.sessionId ?? null;
    let transient = false;
    let navigationError: string | null = null;
    if (sessionId) {
      try {
        // Only authorized metadata may establish ownership. Never export to probe IDs.
        const record = (await api.listSessions()).find(row => row.id === sessionId);
        if (generation !== navigationGenerationRef.current) return;
        if (record && list.some(project => project.id === record.projectId)) projectId = record.projectId;
        else {
          if (target) clearMatchingRecent(target.projectId, sessionId);
          sessionId = null;
          if (typeof input === "object") navigationError = zhCN.errors.sessionUnavailable;
          if (recent) { clearRecentSelection(); projectId = fallback; }
        }
      } catch (error) {
        if (generation !== navigationGenerationRef.current) return;
        transient = !(error instanceof ApiError && (error.status === 403 || error.status === 404));
        if (!transient && target) clearMatchingRecent(target.projectId, sessionId);
        navigationError = !transient && typeof input === "object" ? zhCN.errors.sessionUnavailable : error instanceof Error ? error.message : String(error);
        sessionId = null;
        if (recent) projectId = fallback;
      }
    }
    if (generation !== navigationGenerationRef.current) return;
    // Editing before root initialization cancels recent restoration, not the draft.
    if (input === "root" && revision !== selectionRevisionRef.current) {
      projectId = activeProjectIdRef.current ?? fallback;
      sessionId = null;
    }
    if (!list.some(project => project.id === projectId)) {
      if (recent && !transient) clearRecentSelection();
      projectId = fallback;
      sessionId = null;
    }
    activeProjectIdRef.current = projectId;
    activeSessionIdRef.current = null;
    setActiveProjectId(projectId);
    setActiveSessionId(null);
    setSessions(null);
    // Publish metadata only once the editor's project scope is established.
    // Until then the existing projects=null UI gate must stay closed.
    setProjects(list);
    if (projectId === null) {
      setLoadError(navigationError);
      setSessions([]);
      if (!transient) writeRoute(null, "replace");
      return;
    }
    const loaded = await refreshSessions(projectId);
    if (generation !== navigationGenerationRef.current || loaded.kind === "stale") return;
    if (loaded.kind !== "ok") {
      setSessions([]);
      setLoadError(loaded.error);
      setNavigationRetryAvailable(loaded.kind === "transient" || transient);
      if (loaded.kind === "unavailable") {
        // This proves only the queried project unavailable, not an earlier target.
        clearMatchingRecent(projectId);
        if (!transient) writeRoute(list.some(project => project.id === projectId) ? { projectId, sessionId: null } : null, "replace");
      }
      return;
    }
    // Root recent restoration also yields to edits made while the project list
    // was loading. Keep the now-visible project draft, not a restored session.
    if (input === "root" && revision !== selectionRevisionRef.current) sessionId = null;
    setNavigationRetryAvailable(transient);
    if (navigationError) setLoadError(navigationError);
    if (sessionId && loaded.rows.some(row => row.id === sessionId && row.projectId === projectId)) {
      getChatStore(sessionId);
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
      writeRecentSelection(projectId, sessionId);
    } else if (sessionId) {
      clearMatchingRecent(projectId, sessionId);
      sessionId = null;
      if (typeof input === "object") setLoadError(zhCN.errors.sessionUnavailable);
    }
    if (!transient && target?.sessionId === null && target.projectId === projectId && revision === selectionRevisionRef.current) {
      writeRecentSelection(projectId, null);
    }
    // Do not turn the root-only default fallback into an unverified deep link.
    // Keeping / also preserves first-send behavior on refresh, without fake metadata.
    if (!transient) writeRoute(list.some(project => project.id === projectId) ? { projectId, sessionId } : null, "replace");
  }

  async function retryNavigation(): Promise<void> {
    const generation = advanceNavigation();
    const revision = ++selectionRevisionRef.current;
    ++sessionsRequestSeqRef.current;
    await resolveRoute(readRoute(), generation, revision);
  }

  async function retryProjects(): Promise<void> {
    setProjectsError(null);
    await refreshProjects();
  }

  async function refreshModels(): Promise<void> {
    if (!api) return;
    try {
      // 按当前项目取：信任项目的 .pi/settings.json 会改各模型的默认思考档位。
      const projectId = activeProjectIdRef.current;
      const data = await api.listModels(projectId ?? undefined);
      if (projectId !== activeProjectIdRef.current) return;
      setModels(data.models);
      setThinkingLevels(data.thinkingLevels);
      setDefaultModel(data.defaultModel);
      setDefaultThinkingLevel(data.defaultThinkingLevel);
      setModelThinkingLevels(data.modelThinkingLevels ?? {});
    } catch {
      // 模型列表加载失败不阻塞主流程。
    }
  }

  useEffect(() => {
    if (api) {
      // 项目元数据确定后，由单一导航流程加载列表并校验 URL。
      void api.getAccess().then(setAccess).catch(() => setAccess({ canRead: false, canWrite: false }));
      void refreshProjects();
    }
  }, [api]);
  // 模型列表随项目变：各模型的默认思考档位可以被项目的 .pi/settings.json 改掉。
  useEffect(() => {
    if (api) void refreshModels();
  }, [api, activeProjectId]);

  useEffect(() => listenRoute(() => {
    const generation = advanceNavigation();
    const revision = ++selectionRevisionRef.current;
    ++sessionsRequestSeqRef.current;
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    setSessions(null);
    void (async () => {
      // A startup promise may also be awaiting old session metadata. Once project
      // metadata exists, newer navigation must not wait for that stale generation.
      if (projectsRef.current === null) await projectsPromiseRef.current;
      if (generation === navigationGenerationRef.current) await resolveRoute(readRoute(), generation, revision);
    })();
  }), [api]);

  function logEvent(event: SseEvent): void {
    eventSeqRef.current += 1;
    const seq = eventSeqRef.current;
    const { type, ...data } = event;
    setEventLog((prev) => [
      ...prev,
      {
        seq,
        time: formatTime(Date.now()),
        type,
        data,
      },
    ]);
  }

  const { pendingControls, steer, followUp, applyControlEvent, controlQueue, controlQueueLoading,
    controlQueueError, controlQueueOperations, refreshControlQueue, resetControlQueueAuthority, deleteControl, promoteControl } = useSessionControls({
    api, activeSessionId, navigationGeneration, canWrite: access?.canWrite === true,
    historyLoading: activeSessionId !== null && !historyReadySessionIds.has(activeSessionId),
    captureSnapshot, getChatStore, draftTextRevisionsRef, updateUnsent, reportChatError,
    primarySubmissionBlocked: sessionId => {
      const scope = `session:${sessionId}`;
      if (submittingScopesRef.current.has(scope)) return true;
      // Input ownership may remain in new:<project> after navigation during creation.
      return Object.values(submitStatesRef.current).some(pending => pending.snapshot.sessionId === sessionId &&
        (pending.phase === "creating" || pending.phase === "configuring" ||
          pending.phase === "submitting" || pending.phase === "unknown"));
    },
  });

  const streamNavigationGeneration = navigationGeneration;
  useSessionStream({
    api, activeSessionId, navigationGeneration,
    isCurrent: () => streamNavigationGeneration === navigationGenerationRef.current && activeSessionIdRef.current === activeSessionId,
    chatStore, newlyCreatedIdsRef, historyReadySessionIdsRef,
    emptyHistoryIdsRef, eventCursorsRef, usageRevisionRef, setHistoryReadySessionIds,
    setUsageSnapshots, setInvalidContexts, setConnection,
    onInvalidSession: (sessionId) => {
      if (streamNavigationGeneration !== navigationGenerationRef.current || activeSessionIdRef.current !== sessionId) return;
      advanceNavigation();
      ++selectionRevisionRef.current;
      if (activeProjectIdRef.current) clearMatchingRecent(activeProjectIdRef.current, sessionId);
      activeSessionIdRef.current = null;
      setActiveSessionId(null);
      setLoadError(zhCN.errors.sessionUnavailable);
      setNavigationRetryAvailable(false);
      writeRoute(activeProjectIdRef.current ? { projectId: activeProjectIdRef.current, sessionId: null } : null, "replace");
    },
    rememberFirstPrompt,
    onLoad: () => { setEventLog([]); setHistoryNotice(null); },
    onOpen: () => { refreshControlQueue(); setInspectionRefreshKey(key => key + 1); },
    onEpochReset: () => { resetControlQueueAuthority(); setInspectionRefreshKey(key => key + 1); },
    onEvent: (sessionId, store, event) => {
      if (event.type === "steps_changed") setStepsPosition(`${sessionId}:${event.projectionId}:${event.revision}`);
      if (event.type === "subagents_changed") setSubagentsPosition(`${sessionId}:${event.revision}`);
      if (event.type === "title_changed") {
        // A rename elsewhere or the automatic title: a list read that started earlier must not revert it.
        explicitTitlesRef.current.set(sessionId, event.title);
        setSessions((previous) => previous?.map((row) => row.id === sessionId ? { ...row, title: event.title } : row) ?? null);
      }
      if (ownsSseEvent(store.getState(), event) && (event.type === "queued" || event.type === "status" || event.type === "compaction_start") && event.requestId) {
        // Input ownership can remain in new:<project> after navigation during creation.
        // Match transport identity, never editor text or the currently selected scope.
        const match = Object.entries(submitStatesRef.current).find(([, pending]) =>
          pending.snapshot.sessionId === sessionId && pending.snapshot.requestId === event.requestId &&
          pending.stage === "send" && (pending.phase === "submitting" || pending.phase === "unknown"));
        const receipt = inflightReceiptsRef.current.get(event.requestId);
        if (match && receipt?.sessionId === sessionId) receipt.accepted = true;
        const [scope, pending] = match ?? [];
        if (scope && pending?.phase === "unknown") {
          const confirmed = pending.snapshot;
          projectAcceptedImages(store, confirmed);
          rememberAcceptedPrompt(sessionId, confirmed.text);
          store.setError(null);
          updateSubmitState(scope, { ...pending, phase: "accepted", error: undefined });
          clearSubmittedInputs(confirmed.scope, confirmed);
        }
      }
      if (ownsSseEvent(store.getState(), event) && (event.type === "usage" || (event.type === "status" && event.phase === "agent_start"))) {
        setUsageSnapshots(previous => ({ ...previous, [sessionId]: undefined }));
        if (event.type === "usage") setInvalidContexts(previous => { const next = new Set(previous); next.delete(sessionId); return next; });
      }
      applyControlEvent(sessionId, store, event);
      logEvent(event);
      store.applyEvent(event);
    },
  });

  const projectAllowsCreation = projects?.find(project => project.id === activeProjectId)?.canCreateSession !== false;
  const creationNotice = projectAllowsCreation ? null : zhCN.errors.creationForbidden;

  /** Enter a page-local start state; this action never calls the session creation API. */
  function createSession(): void {
    if (activeProjectId === null || sessions === null || !projectAllowsCreation) return;
    rememberSelection(activeProjectId, null);
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    setLoadError(null);
    setNavigationRetryAvailable(false);
  }

  async function createSessionWithMessage(text: string): Promise<boolean> {
    return (await submitCurrentMessage(text)) === "accepted";
  }

  async function createProject(name: string, cwd: string): Promise<void> {
    if (!api) return;
    // The request is not navigation: keep the current list and stream owner
    // until success actually selects the created project.
    const generation = navigationGenerationRef.current;
    const project = await api.createProject(name, cwd);
    draftProjectsRef.current.set(project.id, project);
    if (generation !== navigationGenerationRef.current) {
      await refreshProjects(true);
      return;
    }
    projectsRef.current = [...(projectsRef.current ?? []), project];
    rememberSelection(project.id, null);
    await resolveRoute({ projectId: project.id, sessionId: null }, navigationGenerationRef.current, selectionRevisionRef.current);
    await refreshProjects(true);
  }

  async function deleteSession(id: string): Promise<void> {
    if (!api) return;
    const deletionGeneration = navigationGenerationRef.current;
    await api.deleteSession(id);
    chatStoresRef.current.delete(id);
    eventCursorsRef.current.delete(id);
    historyReadySessionIdsRef.current.delete(id);
    setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));
    setSessions((prev) => (prev ?? []).filter((session) => session.id !== id));
    if (readRecentSelection()?.sessionId === id) clearRecentSelection();
    if (id === activeSessionIdRef.current && deletionGeneration === navigationGenerationRef.current) {
      advanceNavigation();
      ++selectionRevisionRef.current;
      activeSessionIdRef.current = null;
      setActiveSessionId(null);
      if (activeProjectIdRef.current) writeRoute({ projectId: activeProjectIdRef.current, sessionId: null }, "replace");
    }
    await refreshProjects(true);
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

  function reportChatError(sessionId: string, err: unknown): void {
    if (activeSessionIdRef.current !== sessionId) return;
    getChatStore(sessionId).setError(err instanceof Error ? err.message : String(err));
  }

  async function changeSessionConfig(
    id: string,
    config: { modelProvider?: string; modelId?: string; thinkingLevel?: string },
  ): Promise<void> {
    if (!api) return;
    if (config.modelProvider !== undefined || config.modelId !== undefined) invalidateContext(id);
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

  function captureSnapshot(scope: string, text: string): SubmitSnapshot | null {
    const draft = draftStore.getSnapshot(scope);
    const attachments = draft.attachments;
    if (attachments.some((item) => item.status !== "ready")) return null;
    const fileIds = attachments.flatMap((item) => item.server ? [item.server.fileId] : []);
    const images = attachments.flatMap((item) => item.image ? [{ mediaType: item.image.mediaType, base64: item.image.base64 }] : []);
    if (!text.trim() && !fileIds.length && !images.length) return null;
    const session = activeSessionId ? sessions?.find((row) => row.id === activeSessionId) : null;
    const projectId = session?.projectId ?? activeProjectId;
    if (!projectId) return null;
    return { scope, projectId, sessionId: session?.id ?? null, requestId: crypto.randomUUID(),
      createRequestId: crypto.randomUUID(), text: text.trim(), localIds: attachments.map((item) => item.localId),
      fileIds: [...fileIds], images: images.map((image) => ({ ...image })), settings: { ...draft.settings } };
  }

  function knownRejection(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false;
    if (error.status === 409 && error.message.includes("REQUEST_STATUS_UNKNOWN")) return false;
    return error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404 ||
      error.status === 413 || error.status === 415 || error.status === 429 || error.status === 507 ||
      (error.status === 409 && !error.message.includes("REQUEST_STATUS_UNKNOWN"));
  }

  function clearSubmittedInputs(scope: string, snapshot: SubmitSnapshot): void {
    updateUnsent(scope, (current) => ({ ...current,
      text: current.text.trim() === snapshot.text ? "" : current.text,
      attachments: current.attachments.filter((item) => !snapshot.localIds.includes(item.localId)),
    }));
  }

  async function runSnapshot(initialScope: string, original: SubmitSnapshot, resumeAt: "create" | "config" | "send" = "create"): Promise<SubmitOutcome> {
    const navigationGeneration = navigationGenerationRef.current;
    let scope = initialScope;
    let snapshot = original;
    let stage: "create" | "config" | "send" = snapshot.sessionId ? (resumeAt === "create" ? "send" : resumeAt) : "create";
    let createdSession = false;
    let messageId: string | null = null;
    let receipt: { sessionId: string; accepted: boolean } | undefined;
    const update = (phase: SubmissionState["phase"], error?: string) =>
      updateSubmitState(scope, { snapshot, phase, stage, ...(error ? { error } : {}) });
    try {
      if (!snapshot.sessionId) {
        stage = "create";
        update("creating");
        const created = await api.createSession(undefined, snapshot.projectId, snapshot.createRequestId);
        snapshot = { ...snapshot, sessionId: created.id };
        const sessionScope = `session:${created.id}`;
        // Keep known empty-project metadata until an owner-visible list confirms it.
        createdSession = true;
        newlyCreatedIdsRef.current.add(created.id);
        emptyHistoryIdsRef.current.add(created.id);
        getChatStore(created.id);
        // The editor moves to the real session without losing input or the immutable submission.
        const from = draftStore.getSnapshot(initialScope);
        const sessionDraft = draftStore.getAll()[sessionScope];
        const selectionUnchanged = navigationGeneration === navigationGenerationRef.current &&
          activeProjectIdRef.current === snapshot.projectId;
        // Move edited inputs too, never a navigated-away owner or an occupied target.
        // snapshot.scope tracks input ownership, separately from the receiving session.
        if (selectionUnchanged && (sessionDraft === undefined || sessionDraft === EMPTY_MESSAGE)) {
          updateUnsent(sessionScope, () => ({ ...from }));
          updateUnsent(initialScope, () => EMPTY_MESSAGE);
          snapshot = { ...snapshot, scope: sessionScope };
          updateSubmitState(initialScope, null);
          scope = sessionScope;
          submittingScopesRef.current.add(scope);
        }
        setSessions((previous) => activeProjectIdRef.current === snapshot.projectId && !previous?.some((row) => row.id === created.id)
          ? [...(previous ?? []), created] : previous);
        if (selectionUnchanged) {
          rememberSelection(created.projectId, created.id, "replace");
          activeSessionIdRef.current = created.id;
          setActiveSessionId(created.id);
        }
      }
      if (resumeAt !== "send" && Object.keys(snapshot.settings).length) {
        stage = "config";
        update("configuring");
        const configured = await api.updateSessionConfig(snapshot.sessionId!, snapshot.settings);
        setSessions((previous) => previous?.map((row) => row.id === configured.id ? mergeTitleMetadata(configured, true) : row) ?? null);
      }
      stage = "send";
      update("submitting");
      const store = getChatStore(snapshot.sessionId!);
      messageId = `confirmed-${snapshot.requestId}`;
      const label = snapshot.text || (snapshot.fileIds.length ? zhCN.errors.attachmentCount(snapshot.fileIds.length) : "");
      // Image snapshots are projected only after acceptance, never as a sent-looking optimistic image.
      if (!snapshot.images.length) store.addUserMessage(label, messageId, snapshot.requestId);
      else {
        store.beginRequest(snapshot.requestId);
        imageInsertionRef.current.set(snapshot.requestId, store.getState().timeline.length);
      }
      receipt = { sessionId: snapshot.sessionId!, accepted: false };
      inflightReceiptsRef.current.set(snapshot.requestId, receipt);
      const admission = await api.sendMessage(snapshot.sessionId!, { requestId: snapshot.requestId, prompt: snapshot.text,
        ...(snapshot.fileIds.length ? { fileIds: snapshot.fileIds } : {}),
        ...(snapshot.images.length ? { images: snapshot.images } : {}) });
      // Late HTTP admission must not rewind a lifecycle already confirmed by SSE.
      if (admission && typeof admission === "object" && "status" in admission && admission.status === "queued" &&
          store.getState().activeRequestId === snapshot.requestId && store.getState().phase === "submitting") {
        store.applyEvent({ type: "queued", requestId: snapshot.requestId });
      }
      if (snapshot.images.length) projectAcceptedImages(store, snapshot);
      rememberAcceptedPrompt(snapshot.sessionId!, snapshot.text);
      update("accepted");
      clearSubmittedInputs(snapshot.scope, snapshot);
      return "accepted";
    } catch (error) {
      if (stage === "send" && messageId && !snapshot.images.length && !receipt?.accepted) {
        getChatStore(snapshot.sessionId!).rollbackUserMessage(messageId, zhCN.errors.submissionUnconfirmed, !knownRejection(error));
      }
      if (stage === "send" && receipt?.accepted) {
        if (snapshot.images.length) projectAcceptedImages(getChatStore(snapshot.sessionId!), snapshot);
        rememberAcceptedPrompt(snapshot.sessionId!, snapshot.text);
        update("accepted");
        clearSubmittedInputs(snapshot.scope, snapshot);
        return "accepted";
      }
      const message = error instanceof Error ? error.message : String(error);
      // A network/5xx result is ambiguous: no automatic retry, no false failure/success.
      const unknown = stage === "send" ? !knownRejection(error) : error instanceof ApiError ? error.status >= 500 : true;
      update(unknown ? "unknown" : "failed", message);
      if (!unknown && snapshot.sessionId && stage === "send") {
        const store = getChatStore(snapshot.sessionId);
        // A failed retry must not close a newer request that claimed the stream meanwhile.
        store.applyEvent({ type: "error", message, requestId: snapshot.requestId });
      }
      return unknown ? "unknown" : "failed";
    } finally {
      if (receipt && inflightReceiptsRef.current.get(snapshot.requestId) === receipt) {
        inflightReceiptsRef.current.delete(snapshot.requestId);
      }
      submittingScopesRef.current.delete(initialScope);
      submittingScopesRef.current.delete(scope);
      // Visibility depends on the SessionRecord, not message count. Even a
      // rejected first send leaves a persisted session and invalidates this list.
      if (createdSession) void refreshCreatedProjects();
    }
  }

  async function submitCurrentMessage(text: string): Promise<SubmitOutcome> {
    const scope = currentScope;
    if (!activeSessionId && !projectAllowsCreation) return "failed";
    if (submittingScopesRef.current.has(scope) || submitStatesRef.current[scope]?.phase === "unknown") return "unknown";
    if (activeSessionId) {
      const phase = getChatStore(activeSessionId).getState().phase;
      if (phase === "submitting" || phase === "queued") return "failed";
    }
    const snapshot = captureSnapshot(scope, text);
    if (!snapshot || (snapshot.sessionId && !historyReadySessionIdsRef.current.has(snapshot.sessionId))) return "failed";
    submittingScopesRef.current.add(scope);
    setLoadError(null);
    return runSnapshot(scope, snapshot, snapshot.sessionId ? "send" : "create");
  }

  async function sendMessage(text: string): Promise<boolean> {
    return (await submitCurrentMessage(text)) === "accepted";
  }

  async function confirmUnknownCreation(): Promise<SubmitOutcome> {
    const scope = currentScope;
    const pending = submitStatesRef.current[scope];
    if (!pending || pending.phase !== "unknown" || pending.stage !== "create" || submittingScopesRef.current.has(scope)) return "unknown";
    // createRequestId is the server's idempotent lookup/creation key; never allocate a new key here.
    submittingScopesRef.current.add(scope);
    return runSnapshot(scope, pending.snapshot, "create");
  }

  async function retryFailedSubmission(): Promise<SubmitOutcome> {
    const scope = currentScope;
    const pending = submitStatesRef.current[scope];
    if (!pending || pending.phase !== "failed" || submittingScopesRef.current.has(scope)) return "failed";
    submittingScopesRef.current.add(scope);
    return runSnapshot(scope, pending.snapshot, pending.stage);
  }

  function abort(): void {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    getChatStore(sessionId).clearModelOutput();
    api.abort(sessionId).catch((err) => reportChatError(sessionId, err));
  }

  // A blank composer drafts into the selected project, so its menus read that project.
  const loadCommands = useCallback(async () => {
    if (activeSessionId) return (await api.listSessionCommands(activeSessionId)).commands;
    return activeProjectId ? (await api.listProjectCommands(activeProjectId)).commands : [];
  }, [api, activeSessionId, activeProjectId]);

  const companionGreeting = useCallback(async (input: CompanionGreetingInput) => {
    if (!activeProjectId) throw new Error("no project");
    return api.companionGreeting(activeProjectId, input);
  }, [api, activeProjectId]);

  const companionPersona = useMemo(() => ({
    load: async () => (await api.companionPersona()).persona,
    save: async (persona: CompanionPersonaRecord) => { await api.saveCompanionPersona(persona); },
  }), [api]);

  const searchFiles = useCallback(async (query: string) => {
    if (activeSessionId) return (await api.searchSessionFiles(activeSessionId, query)).entries;
    return activeProjectId ? (await api.searchProjectFiles(activeProjectId, query)).entries : [];
  }, [api, activeSessionId, activeProjectId]);

  /**
   * /compact reports through its compaction events; /reload returns what it loaded; an extension
   * command's output reaches the timeline as a command_output event.
   */
  async function runCommand(input: SessionCommandInput): Promise<string | null> {
    if (!activeSessionId) return null;
    try {
      const result = await api.runSessionCommand(activeSessionId, input);
      return result.command === "reload" ? zhCN.composer.reloaded(result) : null;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // Show the server's one-line reason, not the raw "HTTP 422: {json}" envelope.
      const body = /^HTTP \d+: (.*)$/s.exec(error.message)?.[1];
      let parsed: { message?: unknown; code?: unknown } = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* non-JSON body */ }
      if (parsed.code === "COMMAND_ABORTED") return zhCN.composer.compactCancelled;
      const typed = input.command === "extension" ? input.name ?? "" : input.command;
      throw new Error(typeof parsed.message === "string" && parsed.message ? zhCN.composer.commandFailed(typed, parsed.message) : error.message);
    }
  }

  /** First answer wins; a 409 means another page answered, or the question closed. */
  async function answerCommandPrompt(answer: import("pi-agent-server/client").CommandPromptAnswer): Promise<void> {
    if (!activeSessionId) return;
    await api.answerCommandPrompt(activeSessionId, answer);
  }

  function clearEventLog(): void {
    setEventLog([]);
  }

  function selectSession(sessionId: string | null): void {
    if (sessionId !== null && !sessions?.some(row => row.id === sessionId && row.projectId === activeProjectId)) return;
    if (activeProjectId) rememberSelection(activeProjectId, sessionId);
    activeSessionIdRef.current = sessionId;
    setNavigationRetryAvailable(false);
    if (sessionId !== null) {
      getChatStore(sessionId);
      if (sessionId !== activeSessionId) invalidateContext(sessionId);
    }
    setActiveSessionId(sessionId);
  }

  function selectProject(projectId: string): void {
    if (!projectsRef.current?.some(project => project.id === projectId)) return;
    rememberSelection(projectId, null);
    void resolveRoute({ projectId, sessionId: null }, navigationGenerationRef.current, selectionRevisionRef.current);
  }

  return {
    api, inspectionRefreshKey, stepsPosition, subagentsPosition, answerCommandPrompt,
    sessions,
    canWrite: access?.canWrite === true,
    projectAllowsCreation,
    creationNotice,
    activeSessionId,
    selectSession,
    projects,
    activeProjectId,
    selectProject,
    models,
    thinkingLevels,
    defaultModel,
    defaultThinkingLevel,
    modelThinkingLevels,
    refreshModels,
    chatState,
    draftSource: draftStore,
    draftScope: currentScope,
    submitState,
    pendingControls,
    controlQueue,
    controlQueueLoading,
    controlQueueError,
    controlQueueOperations,
    refreshControlQueue,
    deleteControl,
    promoteControl,
    setUnsentText,
    setNewSessionSettings,
    addUnsentFile,
    retryUnsentAttachment,
    removeUnsentAttachment,
    retryFailedSubmission,
    confirmUnknownCreation,
    historyLoading: activeSessionId !== null && !historyReadySessionIds.has(activeSessionId),
    loadError,
    navigationRetryAvailable,
    projectsError,
    eventLog,
    connected,
    connection,
    historyNotice,
    retryProjects,
    retryNavigation,
    createSession,
    createSessionWithMessage,
    createProject,
    deleteSession,
    renameSession,
    exportSession,
    changeSessionConfig,
    sendMessage,
    steer,
    followUp,
    abort,
    loadCommands,
    companionGreeting,
    companionPersona,
    searchFiles,
    runCommand,
    clearEventLog,
  };
}
