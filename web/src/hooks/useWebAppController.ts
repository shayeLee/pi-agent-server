import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DEFAULT_PROJECT_ID, ApiClient, ApiError, createChatStore, createSseConnection, firstUserPrompt, ownsSseEvent } from "pi-agent-server/client";
import type { AccessCapabilities, ChatStore, ModelInfo, Project, SessionRecord, SseEvent, TimelineItem, UsageSnapshot } from "pi-agent-server/client";
import type { EventLogEntry } from "../types.js";
import { EMPTY_MESSAGE, validateSelection, type SubmissionState, type SubmitOutcome, type SubmitSnapshot, type UnsentAttachment, type UnsentMessage } from "../attachment-state.js";

import { readMessageImages } from "../message-images.js";
import { createDraftStore } from "../draft-store.js";
import { clearRecentSelection, readRecentSelection, writeRecentSelection } from "../recent-selection.js";
import { toolDurationMs } from "../../../src/shared/tool-duration.js";

function projectExportTimeline(raw: readonly unknown[], messages: readonly unknown[]): TimelineItem[] {
  const imagesBySource = new Map<string, ReturnType<typeof readMessageImages>>();
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (row.role === "user" && typeof row.sourceId === "string") imagesBySource.set(row.sourceId, readMessageImages(row.images));
  }
  const items: TimelineItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (row.type === "notification" && row.version === 1 && typeof row.notificationId === "string" && typeof row.entryId === "string" && typeof row.text === "string" && Array.isArray(row.runIds) && row.runIds.every(id => typeof id === "string")) {
      const id = `notification:${row.notificationId}`;
      if (!items.some(item => item.id === id)) items.push({ kind: "notification", id, version: 1, notificationId: row.notificationId, entryId: row.entryId, text: row.text, runIds: row.runIds as string[], timestamp: String(row.timestamp ?? "") });
    } else if (row.type === "message" && (row.role === "user" || row.role === "assistant") && typeof row.text === "string") {
      items.push({ kind: "message", id: row.role === "user" && typeof row.messageId === "string" ? `history-message:${row.messageId}` : `history-${String(row.id ?? items.length)}`,
        role: row.role, text: row.text, streaming: false,
        ...(row.role === "user" && typeof row.messageId === "string" ? { images: imagesBySource.get(row.messageId) } : {}) });
    } else if (row.type === "thinking" && typeof row.text === "string") {
      items.push({ kind: "thinking", id: `history-${String(row.id ?? items.length)}`,
        text: row.text, streaming: false });
    } else if (row.type === "tool_call" && typeof row.toolCallId === "string" && typeof row.toolName === "string") {
      items.push({ kind: "tool", id: `history-${String(row.id ?? items.length)}`, call: {
        toolCallId: row.toolCallId, toolName: row.toolName, args: row.args,
        partialResult: undefined, result: undefined, isError: row.status === "error", done: false,
      } });
    } else if (row.type === "tool_result" && typeof row.toolCallId === "string") {
      let index = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item?.kind === "tool" && item.call.toolCallId === row.toolCallId) { index = i; break; }
      }
      const durationMs = toolDurationMs(row.durationMs);
      const duration = durationMs !== undefined ? { durationMs } : {};
      if (index >= 0) {
        const previous = items[index];
        if (previous?.kind === "tool") items[index] = { ...previous, call: {
          ...previous.call, result: row.result, isError: row.isError === true, done: true, ...duration,
        } };
      } else {
        items.push({ kind: "tool", id: `history-${String(row.id ?? items.length)}`, call: {
          toolCallId: row.toolCallId, toolName: String(row.toolName ?? "工具"), args: undefined,
          partialResult: undefined, result: row.result, isError: row.isError === true, done: true, ...duration,
        } });
      }
    }
  }
  return items;
}

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

  async function refreshSessions(projectId: string): Promise<void> {
    if (!api) return;
    const seq = ++sessionsRequestSeqRef.current;
    const titlesAtStart = new Map(explicitTitlesRef.current);
    try {
      setLoadError(null);
      const list = await api.listSessionsByProject(projectId);
      if (seq !== sessionsRequestSeqRef.current || activeProjectIdRef.current !== projectId) return;
      setSessions(list.map((row) => mergeTitleMetadata(row,
        titlesAtStart.get(row.id) !== explicitTitlesRef.current.get(row.id))));
      const restore = pendingRestoreRef.current;
      if (restore?.projectId === projectId && restore.revision === selectionRevisionRef.current) {
        pendingRestoreRef.current = null;
        if (list.some(row => row.id === restore.sessionId && row.projectId === projectId)) {
          getChatStore(restore.sessionId);
          writeRecentSelection(projectId, restore.sessionId);
          setActiveSessionId(restore.sessionId);
        } else {
          clearRecentSelection();
        }
      }
    } catch (err) {
      if (seq !== sessionsRequestSeqRef.current) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404) && pendingRestoreRef.current?.projectId === projectId) {
        pendingRestoreRef.current = null;
        clearRecentSelection();
      }
      setLoadError(err instanceof Error ? err.message : String(err));
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
    try {
      const list = await api.listProjects();
      for (const project of list) draftProjectsRef.current.delete(project.id);
      list.push(...draftProjectsRef.current.values());
      if (metadataOnly) {
        // Creation invalidates owner-visible metadata, not the user's navigation.
        setProjects(list);
        setProjectsError(null);
        return;
      }
      const defaultId = list.find((project) => project.isDefault)?.id ?? list[0]?.id ?? DEFAULT_PROJECT_ID;
      let restoredProjectId: string | null = null;
      if (!restoreAttemptedRef.current && revision === selectionRevisionRef.current) {
        restoreAttemptedRef.current = true;
        const recent = readRecentSelection();
        if (recent) {
          try {
            // There is no detail GET. One metadata list resolves native session moves;
            // never probe every history/export or trust the stored project association.
            const record = recent.sessionId ? (await api.listSessions()).find(row => row.id === recent.sessionId) : null;
            if (revision === selectionRevisionRef.current) {
              const projectId = recent.sessionId ? record?.projectId : recent.projectId;
              if (projectId && list.some(project => project.id === projectId)) {
                restoredProjectId = projectId;
                if (recent.sessionId) pendingRestoreRef.current = { projectId, sessionId: recent.sessionId, revision };
              } else clearRecentSelection();
            }
          } catch (error) {
            // Transient failures preserve the hint; never send or create on restore.
            if (revision === selectionRevisionRef.current && error instanceof ApiError && (error.status === 403 || error.status === 404)) clearRecentSelection();
          }
        }
      }
      setProjects(list);
      setProjectsError(null);
      setActiveProjectId((prev) =>
        revision !== selectionRevisionRef.current && prev !== null ? prev :
        restoredProjectId ?? (prev === null || !list.some((project) => project.id === prev) ? defaultId : prev),
      );
    } catch (err) {
      // A post-create metadata failure must not invalidate an accepted send,
      // its draft/snapshot, recent selection, or another project's session state.
      if (metadataOnly) return;
      if (revision === selectionRevisionRef.current && err instanceof ApiError && (err.status === 403 || err.status === 404)) clearRecentSelection();
      if (revision !== selectionRevisionRef.current) return;
      ++sessionsRequestSeqRef.current;
      setProjectsError(
        `项目列表加载失败：${err instanceof Error ? err.message : String(err)}。请确认服务可用后重试。`,
      );
      // Do not erase a newer user choice on an old request failure.
      if (revision !== selectionRevisionRef.current) return;
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
      void api.getAccess().then(setAccess).catch(() => setAccess({ canRead: false, canWrite: false }));
      void refreshProjects();
      void refreshModels();
    }
  }, [api]);

  useEffect(() => {
    if (api && activeProjectId !== null) {
      setActiveSessionId(null);
      setSessions(null); // 切换项目时先隐藏旧项目会话，待新列表加载后才允许创建
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
    const freshSession = newlyCreatedIdsRef.current.has(sessionId);
    const restoreOnLoad = !freshSession && !historyReadySessionIdsRef.current.has(sessionId);
    const stateAtLoadStart = store.getState();
    const usageRevision = usageRevisionRef.current.get(sessionId) ?? 0;
    setEventLog([]);
    setHistoryNotice(null);
    let cancelled = false;
    let connection: { close: () => void } | null = null;

    void (async () => {
      let cursor = eventCursorsRef.current.get(sessionId) ?? 0;
      try {
        // A just-created session has no earlier history. Start from cursor 0 so events
        // emitted before React subscribes are replayed, rather than skipped by an export cursor.
        if (!freshSession) {
        const data = (await api.exportSession(sessionId)) as {
          messages?: unknown;
          timeline?: unknown;
          lastEventId?: number;
          usageSnapshot?: UsageSnapshot;
        };
        if (cancelled) return;
        const messages = data?.messages ?? data;
        const legacyHistory = (Array.isArray(messages) ? messages : [])
          .filter(
            (message): message is { role: string; text: string; images?: unknown; sourceId?: string } =>
              typeof message === "object" &&
              message !== null &&
              typeof (message as { text?: unknown }).text === "string",
          )
          .map((message, index) => ({
            kind: "message" as const,
            id: message.role === "user" && typeof message.sourceId === "string" ? `history-message:${message.sourceId}` : `hist-${index}`,
            role: (message.role === "user" ? "user" : "assistant") as "user" | "assistant",
            text: message.text,
            ...(message.role === "user" ? { images: readMessageImages(message.images) } : {}),
            streaming: false,
          }));
        if (Array.isArray(messages)) {
          rememberFirstPrompt(sessionId, firstUserPrompt(messages));
          if (messages.length === 0 && (!Array.isArray(data?.timeline) || data.timeline.length === 0)) emptyHistoryIdsRef.current.add(sessionId);
        }
        const rawTimeline = data?.timeline;
        const history = Array.isArray(rawTimeline) && rawTimeline.length
          ? projectExportTimeline(rawTimeline, Array.isArray(messages) ? messages : []) : legacyHistory;
        const untouchedUsage = store.getState() === stateAtLoadStart;
        // Restore only the first baseline, and only if the store stayed untouched while loading.
        // Returning to a session must preserve its SSE stream and optimistic sends.
        if (
          restoreOnLoad &&
          store.getState() === stateAtLoadStart &&
          history.length > 0
        ) {
          store.restoreHistory(history);
        }
        if (untouchedUsage) {
          if (usageRevision === (usageRevisionRef.current.get(sessionId) ?? 0)) {
            store.restoreExecution(data.usageSnapshot?.execution);
            setUsageSnapshots(previous => ({ ...previous, [sessionId]: data.usageSnapshot ?? {} }));
            if (data.usageSnapshot) setInvalidContexts(previous => { const next = new Set(previous); next.delete(sessionId); return next; });
          }
        }
        // Only the initial export baseline may skip events already represented by history.
        // Returning sessions keep their cached timeline and replay all missed lifecycle/data.
        if (!eventCursorsRef.current.has(sessionId) && untouchedUsage && typeof data?.lastEventId === "number") cursor = data.lastEventId;
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          clearRecentSelection();
          setActiveSessionId(null);
          return;
        }
        // Transient export failure must not erase the remembered position.
      }
      if (cancelled) return;
      historyReadySessionIdsRef.current.add(sessionId);
      setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));

      eventCursorsRef.current.set(sessionId, cursor);
      connection = createSseConnection({
        url: `/v1/sessions/${sessionId}/events`,
        lastEventId: cursor,
        onOpen: () => {
          if (!cancelled) setConnected(true);
        },
        onError: () => {
          store.clearModelOutput();
          if (!cancelled) setConnected(false);
        },
        onDisconnect: () => {
          store.clearModelOutput();
          if (!cancelled) setConnected(false);
        },
        onNoLiveStream: () => {
          store.clearModelOutput();
          if (!cancelled) setConnected(false);
        },
        onEvent: (event, lastEventId) => {
          if (cancelled) return;
          if (Number.isFinite(lastEventId)) eventCursorsRef.current.set(sessionId, lastEventId);
          if (ownsSseEvent(store.getState(), event) && (event.type === "queued" || event.type === "status") && event.requestId) {
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
          if (event.type === "steering_consumed" && ownsSseEvent(store.getState(), event)) {
            setPendingControls(current => {
              const rows = current[sessionId] ?? [];
              const consumed = rows.find(row => row.kind === "steer" && row.id === event.controlId &&
                row.requestId === event.requestId && row.acknowledgementId === event.acknowledgementId);
              if (!consumed) return current;
              return { ...current, [sessionId]: rows.filter(row => row !== consumed) };
            });
            const snapshot = controlSnapshotsRef.current.get(event.controlId);
            if (snapshot && snapshot.sessionId === sessionId && snapshot.requestId === event.requestId &&
                snapshot.acknowledgementId === event.acknowledgementId) {
              controlSnapshotsRef.current.delete(event.controlId);
              updateUnsent(snapshot.snapshot.scope, current => ({ ...current,
                text: (draftTextRevisionsRef.current.get(snapshot.snapshot.scope) ?? 0) === snapshot.textRevision ? "" : current.text,
                attachments: current.attachments.filter(item => !snapshot.snapshot.localIds.includes(item.localId)),
              }));
            }
          }
          logEvent(event);
          store.applyEvent(event);
        },
      });
      newlyCreatedIdsRef.current.delete(sessionId);
    })();

    return () => {
      cancelled = true;
      connection?.close();
      store.clearModelOutput();
      setConnected(false);
    };
  }, [api, activeSessionId, chatStore]);

  const projectAllowsCreation = projects?.find(project => project.id === activeProjectId)?.canCreateSession !== false;
  const creationNotice = projectAllowsCreation ? null : "当前权限无法在此项目新建会话";

  /** Enter a page-local start state; this action never calls the session creation API. */
  function createSession(): void {
    if (activeProjectId === null || sessions === null || !projectAllowsCreation) return;
    rememberSelection(activeProjectId, null);
    setActiveSessionId(null);
    setLoadError(null);
  }

  async function createSessionWithMessage(text: string): Promise<boolean> {
    return (await submitCurrentMessage(text)) === "accepted";
  }

  async function createProject(name: string, cwd: string): Promise<void> {
    if (!api) return;
    ++navigationGenerationRef.current;
    ++selectionRevisionRef.current;
    pendingRestoreRef.current = null;
    const project = await api.createProject(name, cwd);
    rememberSelection(project.id, null);
    draftProjectsRef.current.set(project.id, project);
    setActiveProjectId(project.id);
    activeProjectIdRef.current = project.id;
    setActiveSessionId(null);
    setSessions([]);
    await refreshProjects();
  }

  async function deleteProject(id: string): Promise<void> {
    if (!api) return;
    await api.deleteProject(id);
    draftProjectsRef.current.delete(id);
    if (readRecentSelection()?.projectId === id) clearRecentSelection();
    await refreshProjects();
  }

  async function deleteSession(id: string): Promise<void> {
    if (!api) return;
    await api.deleteSession(id);
    cancelRetries(id);
    chatStoresRef.current.delete(id);
    eventCursorsRef.current.delete(id);
    historyReadySessionIdsRef.current.delete(id);
    setHistoryReadySessionIds(new Set(historyReadySessionIdsRef.current));
    setSessions((prev) => (prev ?? []).filter((session) => session.id !== id));
    if (readRecentSelection()?.sessionId === id) clearRecentSelection();
    if (id === activeSessionId) {
      ++navigationGenerationRef.current;
      ++selectionRevisionRef.current;
      pendingRestoreRef.current = null;
      setActiveSessionId(null);
    }
    await refreshProjects();
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
          rememberSelection(created.projectId, created.id);
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
      const label = snapshot.text || (snapshot.fileIds.length ? `附件（${snapshot.fileIds.length} 个）` : "");
      // Image snapshots are projected only after acceptance, never as a sent-looking optimistic image.
      if (!snapshot.images.length) store.addUserMessage(label, messageId, snapshot.requestId);
      else {
        store.beginRequest(snapshot.requestId);
        imageInsertionRef.current.set(snapshot.requestId, store.getState().timeline.length);
      }
      receipt = { sessionId: snapshot.sessionId!, accepted: false };
      inflightReceiptsRef.current.set(snapshot.requestId, receipt);
      await api.sendMessage(snapshot.sessionId!, { requestId: snapshot.requestId, prompt: snapshot.text,
        ...(snapshot.fileIds.length ? { fileIds: snapshot.fileIds } : {}),
        ...(snapshot.images.length ? { images: snapshot.images } : {}) });
      if (snapshot.images.length) projectAcceptedImages(store, snapshot);
      rememberAcceptedPrompt(snapshot.sessionId!, snapshot.text);
      update("accepted");
      clearSubmittedInputs(snapshot.scope, snapshot);
      return "accepted";
    } catch (error) {
      if (stage === "send" && messageId && !snapshot.images.length && !receipt?.accepted) {
        getChatStore(snapshot.sessionId!).rollbackUserMessage(messageId, "消息提交结果未确认");
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

  const controlSnapshotsRef = useRef(new Map<string, { sessionId: string; requestId: string; acknowledgementId: string; textRevision: number; snapshot: SubmitSnapshot }>());

  function submitControl(kind: "steer" | "followUp", text: string): void {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const id = crypto.randomUUID();
    const scope = `session:${sessionId}`;
    const snapshot = kind === "steer" ? captureSnapshot(scope, text) : null;
    const requestId = getChatStore(sessionId).getState().activeRequestId;
    if (kind === "steer" && (!snapshot || !requestId)) return;
    if (kind === "followUp" && !text.trim()) return;
    if (snapshot?.fileIds.length) { reportChatError(sessionId, new Error("插话暂不支持文件附件；输入已保留")); return; }
    if (snapshot && [...controlSnapshotsRef.current.values()].some(old => old.sessionId === sessionId &&
        old.textRevision === (draftTextRevisionsRef.current.get(scope) ?? 0) && old.snapshot.localIds.join() === snapshot.localIds.join())) return;
    const acknowledgementId = crypto.randomUUID();
    if (snapshot && requestId) controlSnapshotsRef.current.set(id, { sessionId, requestId, acknowledgementId, textRevision: draftTextRevisionsRef.current.get(scope) ?? 0, snapshot });
    const update = (status: "submitting" | "submitted" | "unknown" | "failed") =>
      setPendingControls((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).map((row) =>
        row.id === id ? { ...row, status } : row) }));
    setPendingControls((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []),
      { id, kind, text, ...(snapshot ? { snapshot, requestId: requestId!, acknowledgementId } : {}), status: "submitting" }] }));
    const call = kind === "steer" ? api.steer(sessionId, snapshot!.text, { controlId: id,
      acknowledgementId, requestId: requestId!, images: snapshot!.images }) : api.followUp(sessionId, text);
    void call.then(() => update("submitted"), (error) => {
      const failed = error instanceof ApiError && error.status < 500;
      update(failed ? "failed" : "unknown");
      if (failed) controlSnapshotsRef.current.delete(id);
    });
  }
  function steer(text: string): void { submitControl("steer", text); }
  function followUp(text: string): void { submitControl("followUp", text); }

  function abort(): void {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    getChatStore(sessionId).clearModelOutput();
    api.abort(sessionId).catch((err) => reportChatError(sessionId, err));
  }

  function clearEventLog(): void {
    setEventLog([]);
  }

  function selectSession(sessionId: string | null): void {
    if (activeProjectId) rememberSelection(activeProjectId, sessionId);
    if (sessionId !== null) {
      getChatStore(sessionId);
      if (sessionId !== activeSessionId) invalidateContext(sessionId);
    }
    setActiveSessionId(sessionId);
  }

  function selectProject(projectId: string): void {
    rememberSelection(projectId, null);
    setActiveSessionId(null);
    activeProjectIdRef.current = projectId;
    setActiveProjectId(projectId);
  }

  return {
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
    chatState,
    draftSource: draftStore,
    draftScope: currentScope,
    submitState,
    pendingControls: activeSessionId ? pendingControls[activeSessionId] ?? [] : [],
    setUnsentText,
    setNewSessionSettings,
    addUnsentFile,
    retryUnsentAttachment,
    removeUnsentAttachment,
    retryFailedSubmission,
    confirmUnknownCreation,
    historyLoading: activeSessionId !== null && !historyReadySessionIds.has(activeSessionId),
    loadError,
    projectsError,
    eventLog,
    connected,
    historyNotice,
    retryProjects,
    createSession,
    createSessionWithMessage,
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
