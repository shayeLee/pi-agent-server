import { zhCN } from "../i18n/zh-CN.js";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { ChatState, ModelInfo, Project, SessionRecord, UsageStats } from "pi-agent-server/client";
import { ConversationMinimap } from "./ConversationMinimap.js";
import { Timeline } from "./Timeline.js";
import type { DraftSource } from "../draft-store.js";
import { Composer, type ComposerProps } from "./Composer.js";
import { ControlQueue, type ControlQueueProps } from "./ControlQueue.js";
import { CompactionBanner, type CompactionState } from "./CompactionBanner.js";
import { CommandPromptPanel } from "./CommandPromptPanel.js";
import { StatsBar } from "./StatsBar.js";
import { ChatHeader } from "./ChatHeader.js";
import { useRunStatus } from "../hooks/useRunStatus.js";
import { SubagentLivePanel } from "./SubagentLivePanel.js";
import type { LiveSubagent } from "../hooks/useLiveSubagents.js";
import type { SessionConnection } from "../hooks/useSessionStream.js";
import { EmptyState } from "./EmptyState.js";
import { CompanionDock, CompanionWelcome, useCompanionPersona, usePrefetchGreeting, type CompanionPersonaSync, type CompanionWelcomeProps } from "./companion/Companion.js";
import { useCompanion } from "./companion/companion-mood.js";
import type { SubmissionState, SubmitOutcome, UnsentMessage } from "../attachment-state.js";

export type ChatProps = {
  hidden?: boolean;
  session: SessionRecord | null;
  projects: Project[] | null;
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  canCreateSession: boolean;
  canWrite?: boolean;
  timeline: ChatState["timeline"];
  historyLoading?: boolean;
  historyNotice?: string | null;
  streaming: boolean;
  queued: boolean;
  /** Raw chat phase; drives the header run state (DESIGN.md §5.2). */
  phase?: import("pi-agent-server/client").ChatPhase;
  /** The most recent turn ended with an error event. */
  runFailed?: boolean;
  primaryAwaitingStart?: boolean;
  loadError: string | null;
  models: ModelInfo[];
  thinkingLevels: string[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: string;
  connection: SessionConnection;
  stats: UsageStats | null;
  compaction?: CompactionState | null;
  /** The dialog an extension command is waiting on (SSE-maintained). */
  commandPrompt?: import("pi-agent-server/client").ChatState["commandPrompt"];
  onAnswerCommandPrompt?: (answer: import("pi-agent-server/client").CommandPromptAnswer) => Promise<void>;
  modelOutput?: import("pi-agent-server/client").ChatState["modelOutput"];
  runProgress?: import("pi-agent-server/client").ChatState["runProgress"];
  activeTools?: boolean;
  onSend: (text: string) => void | Promise<boolean>;
  draft?: UnsentMessage;
  draftSource?: DraftSource;
  draftScope?: string;
  submission?: SubmissionState | null;
  controlQueue?: { requestId: string | null; revision: number; items: ControlQueueProps["items"] } | null;
  controlQueueLoading?: boolean;
  controlQueueError?: string | null;
  controlQueueOperations?: ControlQueueProps["operations"];
  refreshControlQueue?: () => void;
  deleteControl?: (id: string) => void;
  promoteControl?: (id: string) => void;
  pendingControls?: Array<{ id: string; kind: "steer" | "followUp"; text: string; status: "submitting" | "submitted" | "unknown" | "failed"; blocking?: boolean }>;
  onDraftText?: (text: string) => void;
  onDraftSettings?: (config: UnsentMessage["settings"]) => void;
  onAddFile?: (file: File) => Promise<void>;
  onRetryFile?: (localId: string) => Promise<void>;
  onRemoveFile?: (localId: string) => void;
  onRetrySubmit?: () => Promise<SubmitOutcome>;
  onConfirmCreation?: () => Promise<SubmitOutcome>;
  onAbort?: () => void;
  onFollowUp: (text: string) => void | Promise<boolean>;
  loadCommands?: ComposerProps["loadCommands"];
  /** The companion's model-written opening line for the selected project (DESIGN.md §6.6). */
  companionGreeting?: CompanionWelcomeProps["generateLines"];
  /** Keeps the companion's persona on the server; without it the persona stays in this browser. */
  companionPersona?: CompanionPersonaSync;
  searchFiles?: ComposerProps["searchFiles"];
  onRunCommand?: ComposerProps["onRunCommand"];
  onToggleTrace?: () => void;
  liveSubagents?: LiveSubagent[];
  onOpenSubagent?: (runId: string) => void;
  onNavigateTurn?: (timelineId: string) => void;
  traceOpen?: boolean;
  /** The project's latest session, for the companion's welcome on a blank session. */
  /** The project's latest session; `undefined` while the list loads. */
  recentSession?: { title: string; updatedAt: number } | null;
  onConfigChange: (config: { modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
};

export function Chat({
  hidden,
  session,
  projects,
  activeProjectId,
  onSelectProject,
  canCreateSession,
  canWrite = true,
  timeline,
  historyLoading = false,
  historyNotice,
  streaming,
  queued,
  phase,
  runFailed = false,
  primaryAwaitingStart = false,
  loadError,
  models,
  thinkingLevels,
  defaultModel,
  defaultThinkingLevel,
  connection,
  stats,
  compaction,
  commandPrompt,
  onAnswerCommandPrompt,
  modelOutput,
  runProgress,
  activeTools,
  onSend,
  draft,
  draftSource,
  draftScope,
  submission,
  controlQueue,
  controlQueueLoading,
  controlQueueError,
  controlQueueOperations,
  refreshControlQueue,
  deleteControl,
  promoteControl,
  pendingControls,
  onDraftText,
  onDraftSettings,
  onAddFile,
  onRetryFile,
  onRemoveFile,
  onRetrySubmit,
  onConfirmCreation,
  onAbort,
  onFollowUp, loadCommands, companionGreeting, companionPersona, searchFiles, onRunCommand,
  onToggleTrace,
  liveSubagents,
  onOpenSubagent,
  onNavigateTurn,
  traceOpen,
  recentSession,
  onConfigChange,
}: ChatProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const derivedPhase = phase ?? (queued ? "queued" : primaryAwaitingStart ? "submitting" : streaming ? "streaming" : "idle");
  const runStatus = useRunStatus(session?.id ?? null, derivedPhase, runFailed);
  const [abortArmed, setAbortArmed] = useState(false);
  const companion = useCompanion(runStatus.kind);
  const [persona, setPersona] = useCompanionPersona(canCreateSession ? companionPersona : undefined);
  // Inside a session, the next blank session's opening line is asked for while nothing runs.
  const runQuiet = runStatus.kind !== "running" && runStatus.kind !== "submitting" && runStatus.kind !== "queued";
  usePrefetchGreeting(session && canCreateSession ? companionGreeting : undefined, activeProjectId, persona, recentSession, runQuiet);
  const sectionRef = useRef<HTMLElement>(null);
  const quickStart = onDraftText ? (text: string) => {
    onDraftText(text);
    const input = sectionRef.current?.querySelector<HTMLTextAreaElement>("[data-testid='composer-input']");
    // After React writes the text, so the caret lands at its end.
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(text.length, text.length); });
  } : undefined;

  // 48px accommodates fractional scroll metrics and small touch movements.
  // Intent lives outside React updates: content growth must not look like scrolling away.
  const followRef = useRef(true);
  const sessionRef = useRef(session?.id);
  const initialHistoryRef = useRef(true);
  const metricsRef = useRef({ top: 0, height: 0, viewport: 0 });
  const [showLatest, setShowLatest] = useState(false);
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 48;
  const remember = (el: HTMLElement) => {
    metricsRef.current = { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
    setShowLatest(!nearBottom(el));
  };
  const goToLatest = () => {
    followRef.current = true;
    const el = bodyRef.current;
    if (el) { el.scrollTop = el.scrollHeight; remember(el); }
  };

  useLayoutEffect(() => {
    if (sessionRef.current !== session?.id) {
      sessionRef.current = session?.id;
      initialHistoryRef.current = true;
      followRef.current = true;
      setShowLatest(false);
    }
    const el = bodyRef.current;
    if (!el) return;
    // An empty/loading export is not the initial history. SSE in the same session
    // must never reinitialize scrolling after that history has been displayed.
    if (initialHistoryRef.current && (historyLoading || !session || timeline.length === 0)) {
      remember(el);
      return;
    }
    initialHistoryRef.current = false;
    if (followRef.current) el.scrollTop = el.scrollHeight;
    remember(el);
  }, [session?.id, historyLoading, timeline]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // Includes images, asynchronous highlighting, and viewport/Composer resize.
      if (followRef.current && !initialHistoryRef.current) el.scrollTop = el.scrollHeight;
      remember(el);
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [session?.id]);

  const controlsBlocked = Object.values(controlQueueOperations ?? {}).some(operation => operation.status === "pending" || operation.status === "unknown");
  // Real resident items remain visible; an empty control read is not the primary request queue.
  const showControlQueue = !!controlQueue?.items?.length || !!controlQueueError;
  const hasMessages = timeline.length > 0;
  // Unloaded history or a first message still in flight is not proof of an empty session.
  const sending = primaryAwaitingStart || submission?.phase === "creating" || submission?.phase === "configuring" || submission?.phase === "submitting";
  const showEmpty = !hasMessages && !historyLoading && !sending && !streaming && !queued;
  let lastUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.kind === "message" && item.role === "user") { lastUserIndex = index; break; }
  }
  const currentReply = timeline.slice(lastUserIndex + 1);
  const waitingForReply = (streaming || primaryAwaitingStart) && !queued &&
    !currentReply.some(item => item.kind === "message" && item.role === "assistant" && item.text.trim());
  // Only a stream that dropped is a problem; a new session's stream is still connecting.
  const streamLost = connection === "reconnecting";
  const thinkingLive = currentReply.some(item => item.kind === "thinking" && item.streaming);
  // DESIGN.md §5.3. The header already says "等待运行确认", and a running step or live thinking
  // row already shows what PI is doing, so this line only says what nothing else on screen does.
  const pendingLine = !waitingForReply ? null
    : streamLost ? <WaitingLine text={zhCN.ledger.reconnecting} warn />
    : primaryAwaitingStart ? <WaitingLine />
    : activeTools || thinkingLive ? null
    : <WaitingLine text={zhCN.ledger.awaitingModel} />;
  const placeholder = zhCN.chat.placeholder;

  return (
    <section className="chat" data-testid="chat" hidden={hidden} ref={sectionRef}>
      {session && (
        <ChatHeader
          session={session}
          cwd={projects?.find(project => project.id === session.projectId)?.cwd ?? null}
          traceOpen={traceOpen ?? false}
          runStatus={runStatus}
          abortArmed={abortArmed}
          onToggleTrace={() => onToggleTrace?.()}
        />
      )}
      <div className="chat-scroll-region">
      <div id="chat-transcript" className="chat-body" ref={bodyRef} data-testid="chat-body"
        role="region" aria-label={zhCN.chat.transcript} tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Home" && event.key !== "End") || event.currentTarget.isContentEditable || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (event.key === "End") goToLatest();
          else {
            followRef.current = false;
            const el = event.currentTarget;
            el.scrollTop = 0;
            remember(el);
          }
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          const previous = metricsRef.current;
          // Layout-induced scroll/clamping is not user intent. Upward movement
          // with unchanged dimensions also covers scrollbar, keyboard and touch.
          if (nearBottom(el)) followRef.current = true;
          else if (el.scrollTop < previous.top && el.scrollHeight === previous.height && el.clientHeight === previous.viewport) {
            followRef.current = false;
          }
          remember(el);
        }}
        onClickCapture={(event) => {
          // Manual disclosures are reading actions, not new output. Keep their
          // anchor in place, even when opened while previously following.
          if ((event.target as Element).closest("button[aria-expanded], summary")) followRef.current = false;
        }}>
        {!session ? (
          <div className="workbench-welcome" data-testid="no-session-hint">
            {loadError && <div className="chat-phase-banner error" role="alert">{loadError}</div>}
            <CompanionWelcome mood={companion.mood} nodKey={companion.nodKey} persona={persona} onPersona={setPersona}
              projectId={activeProjectId} projectName={projects?.find(project => project.id === activeProjectId)?.name ?? null}
              recent={recentSession} loadCommands={canCreateSession ? loadCommands : undefined} generateLines={canCreateSession ? companionGreeting : undefined} onQuickStart={canCreateSession && canWrite ? quickStart : undefined} />
          </div>
        ) : (
          <div className="chat-inner">
            {historyNotice && <div className="chat-history-notice" role="status">{historyNotice}</div>}
            {loadError && (
              <div className="chat-phase-banner error" data-testid="load-error">
                {loadError}
              </div>
            )}
            {queued && (
              <div className="chat-phase-banner queued" data-testid="phase-queued">
                {zhCN.chat.queued}</div>
            )}
            {showEmpty ? (
              <EmptyState />
            ) : hasMessages && (
              <Timeline key={session.id} timeline={timeline} live={streaming || queued || primaryAwaitingStart} ready={!historyLoading}
                tail={liveSubagents?.length ? <SubagentLivePanel items={liveSubagents} onOpen={onOpenSubagent} /> : undefined}
                pending={pendingLine} />
            )}
          </div>
        )}
      </div>
      <ConversationMinimap key={session?.id ?? "empty"} timeline={timeline} viewport={bodyRef} onNavigate={timelineId => { followRef.current = false; onNavigateTurn?.(timelineId); }} />
      </div>
      {session && hasMessages && (
        <div className="chat-latest-row">
          {/* An icon is enough; while PI is still writing below, it turns accent and drifts (DESIGN.md §3). */}
          {showLatest && (
            <button type="button" className="chat-latest" data-live={streaming ? "true" : undefined}
              aria-label={streaming ? zhCN.chat.latestLive : zhCN.chat.latest} title={streaming ? zhCN.chat.latestLive : zhCN.chat.latest} onClick={goToLatest}>
              <span className="chat-latest-face"><Icon name="down" size={18} /></span>
            </button>
          )}
        </div>
      )}
      {(session || projects !== null) && (
        <div className="chat-footer">
          <CompactionBanner key={session?.id ?? "no-session"} compaction={compaction} streamLost={streamLost} />
          {session && commandPrompt && onAnswerCommandPrompt
            && <CommandPromptPanel key={session.id} entry={commandPrompt} canAnswer={canWrite} onAnswer={onAnswerCommandPrompt} />}
          {session && showControlQueue && deleteControl && promoteControl && <ControlQueue items={controlQueue?.items ?? []}
            loading={controlQueueLoading} error={controlQueueError} operations={controlQueueOperations}
            onRefresh={refreshControlQueue} onDelete={deleteControl} onPromote={promoteControl}
            disabled={!canWrite || historyLoading || primaryAwaitingStart || queued || controlsBlocked ||
              pendingControls?.some(item => item.blocking !== false && (item.status === "submitting" || item.status === "unknown")) ||
              submission?.phase === "creating" || submission?.phase === "configuring" || submission?.phase === "submitting" || submission?.phase === "unknown"} />}
          <Composer
            session={session}
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={onSelectProject}
            canCreateSession={canCreateSession}
            canWrite={canWrite}
            models={models}
            thinkingLevels={thinkingLevels}
            defaultModel={defaultModel}
            defaultThinkingLevel={defaultThinkingLevel}
            streaming={streaming}
            queued={queued}
            primaryAwaitingStart={primaryAwaitingStart}
            historyLoading={historyLoading}
            controlsBlocked={controlsBlocked}
            placeholder={placeholder}
            onSend={(text) => { goToLatest(); return onSend(text); }}
            draft={draft}
            draftSource={draftSource}
            draftScope={draftScope}
            submission={submission}
            pendingControls={pendingControls}
            onDraftText={onDraftText}
            onDraftSettings={onDraftSettings}
            onAddFile={onAddFile}
            onRetryFile={onRetryFile}
            onRemoveFile={onRemoveFile}
            onRetrySubmit={onRetrySubmit}
            onConfirmCreation={onConfirmCreation}
            onAbort={hidden ? undefined : onAbort}
            onAbortArmedChange={setAbortArmed}
            onFollowUp={onFollowUp}
            loadCommands={loadCommands}
            searchFiles={searchFiles}
            onRunCommand={onRunCommand}
            onActivity={companion.signal}
            perch={session && hasMessages ? <CompanionDock mood={companion.mood} run={runStatus.kind} nodKey={companion.nodKey} persona={persona} onPersona={setPersona} /> : undefined}
            onConfigChange={onConfigChange}
          />
          {session && hasMessages && <StatsBar stats={stats} streamLost={streamLost} timeline={timeline} pending={streaming || queued} modelOutput={modelOutput} runProgress={runProgress} activeTools={activeTools} />}
        </div>
      )}
    </section>
  );
}

/**
 * PI's line before its first words: a status in --dim mono (or --warn when the stream dropped),
 * ended by the same caret the reply will stream behind. The caret alone means "about to write".
 */
function WaitingLine({ text, warn = false }: { text?: string; warn?: boolean }) {
  return <div className={`ledger-waiting${warn ? " is-warn" : ""}`} data-testid="waiting-reply" role={text ? "status" : undefined}>
    {text && <span className="ledger-waiting-text">{text}</span>}
    {!warn && <span className="ledger-caret" aria-hidden="true" />}
  </div>;
}
