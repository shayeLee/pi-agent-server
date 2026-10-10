import { useEffect, useRef } from "react";
import { DEFAULT_PROJECT_ID, ApiError, createSseConnection, firstUserPrompt, ownsSseEvent } from "pi-agent-server/client";
import type { ChatState, UsageSnapshot, SseEvent } from "pi-agent-server/client";
import { EMPTY_MESSAGE, type SubmitOutcome, type SubmissionState, type SubmitSnapshot } from "../../attachment-state.js";
import { readMessageImages } from "../../message-images.js";
import { clearRecentSelection, readRecentSelection, writeRecentSelection } from "../../recent-selection.js";
import { projectExportTimeline } from "./session-export-timeline.js";
import type { WebAppControllerState } from "./controller-state.js";

/** Projects, sessions, stream, submission, and controls orchestration. */
export function useWebAppControllerActions(state: WebAppControllerState) {
  const {
    api,
    draftStore,
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
    submitState,
    currentScope,
    draftProjectsRef,
    submitStatesRef,
    submittingScopesRef,
    newlyCreatedIdsRef,
    imageInsertionRef,
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
    inflightReceiptsRef,
    eventSeqRef,
    sessionsRequestSeqRef,
    setUsageSnapshots,
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
    chatStore,
    chatState,
  } = state;

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
          compaction?: ChatState["compaction"];
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
        if (!eventCursorsRef.current.has(sessionId) && untouchedUsage && typeof data?.lastEventId === "number") {
          store.restoreCompaction(data.compaction);
          cursor = data.lastEventId;
        }
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
          store.markDisconnected();
          if (!cancelled) setConnected(false);
        },
        onDisconnect: () => {
          store.markDisconnected();
          if (!cancelled) setConnected(false);
        },
        onNoLiveStream: () => {
          store.markDisconnected();
          if (!cancelled) setConnected(false);
        },
        onEvent: (event, lastEventId) => {
          if (cancelled) return;
          if (Number.isFinite(lastEventId)) eventCursorsRef.current.set(sessionId, lastEventId);
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
          if ((event.type === "aborted" || event.type === "completed" || event.type === "error") && event.requestId) {
            // Terminal identity cancels only this request's unconsumed controls, not
            // the current draft. Release the dedup lock before any late HTTP/SSE reply.
            for (const [id, snapshot] of controlSnapshotsRef.current) {
              if (snapshot.sessionId === sessionId && snapshot.requestId === event.requestId) {
                controlSnapshotsRef.current.delete(id);
              }
            }
            setPendingControls(current => {
              const rows = current[sessionId] ?? [];
              const remaining = rows.filter(row => row.kind !== "steer" || row.requestId !== event.requestId);
              return remaining.length === rows.length ? current : { ...current, [sessionId]: remaining };
            });
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
      store.markDisconnected();
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
