import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiClient, ApiError, createChatStore } from "pi-agent-server/client";
import type { AccessCapabilities, ChatStore, ModelInfo, Project, SessionRecord, UsageSnapshot } from "pi-agent-server/client";
import type { EventLogEntry } from "../../types.js";
import { validateSelection, type SubmissionState, type SubmitSnapshot, type UnsentAttachment, type UnsentMessage } from "../../attachment-state.js";
import { createDraftStore } from "../../draft-store.js";
import { writeRecentSelection } from "../../recent-selection.js";
/** Shared controller state, draft helpers, and live chat projection. */
export function useWebAppControllerState() {

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [pendingControls, setPendingControls] = useState<Record<string, Array<{
    id: string; kind: "steer" | "followUp"; text: string; requestId?: string; acknowledgementId?: string; snapshot?: SubmitSnapshot; status: "submitting" | "submitted" | "unknown" | "failed";
  }>>>({});
  const [connected, setConnected] = useState(false);
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
  const restoreAttemptedRef = useRef(false);
  const projectsPromiseRef = useRef<Promise<void> | null>(null);
  const pendingRestoreRef = useRef<{ projectId: string; sessionId: string; revision: number } | null>(null);
  function rememberSelection(projectId: string, sessionId: string | null): void {
    ++navigationGenerationRef.current;
    ++selectionRevisionRef.current;
    pendingRestoreRef.current = null;
    writeRecentSelection(projectId, sessionId);
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
      text: snapshot.text || (snapshot.fileIds.length ? `附件（${snapshot.fileIds.length} 个）` : ""),
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
    pendingRestoreRef.current = null;
    draftTextRevisionsRef.current.set(currentScope, (draftTextRevisionsRef.current.get(currentScope) ?? 0) + 1);
    updateUnsent(currentScope, (previous) => ({ ...previous, text }));
  }
  function setNewSessionSettings(config: UnsentMessage["settings"]): void {
    ++selectionRevisionRef.current;
    pendingRestoreRef.current = null;
    updateUnsent(currentScope, (previous) => ({ ...previous, settings: { ...previous.settings, ...config } }));
  }
  function removeUnsentAttachment(localId: string): void {
    updateUnsent(currentScope, (previous) => ({ ...previous,
      attachments: previous.attachments.filter((item) => item.localId !== localId) }));
  }
  function updateAttachment(scope: string, localId: string, change: (item: UnsentAttachment) => UnsentAttachment): void {
    // An in-flight upload/read may finish after its draft moved to a session.
    const owner = draftStore.getSnapshot(scope).attachments.some(item => item.localId === localId)
      ? scope : Object.keys(draftStore.getAll()).find(key =>
        draftStore.getSnapshot(key).attachments.some(item => item.localId === localId));
    if (!owner) return; // Removed attachments must not be resurrected.
    updateUnsent(owner, (previous) => ({ ...previous, attachments: previous.attachments.map((item) =>
      item.localId === localId ? change(item) : item) }));
  }
  function fileBytes(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(new Uint8Array(reader.result)) : reject(new Error("文件读取失败"));
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsArrayBuffer(file);
    });
  }
  async function uploadSelectedFile(scope: string, projectId: string, localId: string, file: File, kind: Exclude<UnsentAttachment["kind"], "image">, uploadKey: string): Promise<void> {
    try {
      const bytes = await fileBytes(file);
      const server = await api.uploadFile({ projectId, uploadKey, name: file.name, mediaType: file.type,
        kind, bytes });
      updateAttachment(scope, localId, (item) => ({ ...item, status: "ready", file: undefined, error: undefined, server }));
    } catch (error) {
      const interrupted = !(error instanceof ApiError);
      updateAttachment(scope, localId, (item) => ({ ...item, status: interrupted ? "interrupted" : "error",
        file: interrupted ? undefined : file,
        error: interrupted ? "上传中断；请重新选择文件" : error instanceof Error ? error.message : "上传失败" }));
    }
  }
  async function addUnsentFile(file: File): Promise<void> {
    ++selectionRevisionRef.current;
    pendingRestoreRef.current = null;
    const scope = currentScope;
    const existing = draftStore.getSnapshot(scope).attachments;
    const check = validateSelection(existing, file);
    if ("error" in check) {
      const id = crypto.randomUUID();
      updateUnsent(scope, (previous) => ({ ...previous, attachments: [...previous.attachments,
        { localId: id, name: file.name, size: file.size, mediaType: file.type,
          kind: "text", status: "error", error: check.error }] }));
      return;
    }
    const localId = crypto.randomUUID();
    const session = activeSessionId ? sessions?.find((record) => record.id === activeSessionId) : null;
    const projectId = session?.projectId ?? activeProjectId;
    const item: UnsentAttachment = { localId, name: file.name, size: file.size, mediaType: file.type,
      kind: check.kind, status: check.kind === "image" ? "processing" : "uploading",
      ...(check.kind === "image" ? {} : { file, uploadKey: crypto.randomUUID() }) };
    updateUnsent(scope, (previous) => ({ ...previous, attachments: [...previous.attachments, item] }));
    if (check.kind === "image") {
      try {
        const bytes = await fileBytes(file);
        const base64 = btoa(Array.from({ length: Math.ceil(bytes.length / 8192) }, (_, chunk) =>
          String.fromCharCode(...bytes.subarray(chunk * 8192, (chunk + 1) * 8192))).join(""));
        updateAttachment(scope, localId, (current) => ({ ...current, status: "ready",
          image: { mediaType: file.type, base64, preview: `data:${file.type};base64,${base64}` } }));
      } catch {
        updateAttachment(scope, localId, (current) => ({ ...current, status: "error", error: "图片读取失败" }));
      }
    } else if (projectId) {
      await uploadSelectedFile(scope, projectId, localId, file, check.kind, item.uploadKey!);
    } else {
      updateAttachment(scope, localId, (current) => ({ ...current, status: "error", error: "请先选择项目" }));
    }
  }
  async function retryUnsentAttachment(localId: string): Promise<void> {
    const scope = currentScope;
    const item = draftStore.getSnapshot(scope).attachments.find((entry) => entry.localId === localId);
    if (!item?.file || !item.uploadKey || item.kind === "image") return;
    const session = activeSessionId ? sessions?.find((record) => record.id === activeSessionId) : null;
    const projectId = session?.projectId ?? activeProjectId;
    if (!projectId) return;
    updateAttachment(scope, localId, (current) => ({ ...current, status: "uploading", error: undefined }));
    await uploadSelectedFile(scope, projectId, localId, item.file, item.kind, item.uploadKey);
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
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev && prev !== activeSessionId) {
      cancelRetries(prev);
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

  // Receipts live only as long as their HTTP send, independently of navigation/cursors.
  // A pending promise already owns this receipt; no historical confirmation cache is needed.
  const inflightReceiptsRef = useRef(new Map<string, { sessionId: string; accepted: boolean }>());
  const eventSeqRef = useRef(0);
  // 快速切换项目时，旧会话请求的响应/错误不得覆盖当前项目状态。
  const sessionsRequestSeqRef = useRef(0);
  const api = useMemo(() => new ApiClient({ baseUrl: "" }), []);
  return {
    api,
    draftStore,
    emptyChatStore,
    chatStore,
    chatState,
    sessions,
    setSessions,
    access,
    setAccess,
    activeSessionId,
    setActiveSessionId,
    projects,
    setProjects,
    activeProjectId,
    setActiveProjectId,
    models,
    setModels,
    thinkingLevels,
    setThinkingLevels,
    defaultModel,
    setDefaultModel,
    defaultThinkingLevel,
    setDefaultThinkingLevel,
    loadError,
    setLoadError,
    projectsError,
    setProjectsError,
    eventLog,
    setEventLog,
    pendingControls,
    setPendingControls,
    connected,
    setConnected,
    historyNotice,
    setHistoryNotice,
    historyReadySessionIds,
    setHistoryReadySessionIds,
    submitStates,
    setSubmitStates,
    submitState,
    currentScope,
    draftProjectsRef,
    submitStatesRef,
    submittingScopesRef,
    newlyCreatedIdsRef,
    imageInsertionRef,
    firstPromptsRef,
    emptyHistoryIdsRef,
    explicitTitlesRef,
    selectionRevisionRef,
    navigationGenerationRef,
    restoreAttemptedRef,
    projectsPromiseRef,
    pendingRestoreRef,
    historyReadySessionIdsRef,
    chatStoresRef,
    eventCursorsRef,
    draftTextRevisionsRef,
    activeSessionIdRef,
    activeProjectIdRef,
    retryTimersRef,
    inflightReceiptsRef,
    eventSeqRef,
    sessionsRequestSeqRef,
    usageSnapshots,
    setUsageSnapshots,
    invalidContexts,
    setInvalidContexts,
    usageRevisionRef,
    rememberSelection,
    mergeTitleMetadata,
    rememberAcceptedPrompt,
    rememberFirstPrompt,
    projectAcceptedImages,
    getChatStore,
    updateUnsent,
    updateSubmitState,
    cancelRetries,
    invalidateContext,
    setUnsentText,
    setNewSessionSettings,
    removeUnsentAttachment,
    addUnsentFile,
    retryUnsentAttachment,
  };
}
