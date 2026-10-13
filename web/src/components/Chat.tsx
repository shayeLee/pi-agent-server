import { zhCN } from "../i18n/zh-CN.js";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { ChatState, ModelInfo, Project, SessionRecord, UsageStats } from "pi-agent-server/client";
import { ConversationMinimap } from "./ConversationMinimap.js";
import { Timeline } from "./Timeline.js";
import type { DraftSource } from "../draft-store.js";
import { Composer } from "./Composer.js";
import { ControlQueue, type ControlQueueProps } from "./ControlQueue.js";
import { CompactionBanner, type CompactionState } from "./CompactionBanner.js";
import { StatsBar } from "./StatsBar.js";
import { ChatHeader } from "./ChatHeader.js";
import { EmptyState } from "./EmptyState.js";
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
  primaryAwaitingStart?: boolean;
  loadError: string | null;
  models: ModelInfo[];
  thinkingLevels: string[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: string;
  connected: boolean;
  stats: UsageStats | null;
  compaction?: CompactionState | null;
  modelOutput?: import("pi-agent-server/client").ChatState["modelOutput"];
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
  onToggleTrace?: () => void;
  onNavigateTurn?: (timelineId: string) => void;
  traceOpen?: boolean;
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
  primaryAwaitingStart = false,
  loadError,
  models,
  thinkingLevels,
  defaultModel,
  defaultThinkingLevel,
  connected,
  stats,
  compaction,
  modelOutput,
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
  onFollowUp,
  onToggleTrace,
  onNavigateTurn,
  traceOpen,
  onConfigChange,
}: ChatProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

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
  const showControlQueue = !!controlQueue?.items.length || !!controlQueueError;
  const hasMessages = timeline.length > 0;
  let lastUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.kind === "message" && item.role === "user") { lastUserIndex = index; break; }
  }
  const currentReply = timeline.slice(lastUserIndex + 1);
  const waitingForReply = (streaming || primaryAwaitingStart) && !queued &&
    !currentReply.some(item => item.kind === "message" && item.role === "assistant" && item.text.trim());
  const waitingLabel = !connected ? zhCN.stats.disconnected : primaryAwaitingStart ? zhCN.status.submitting
    : activeTools ? zhCN.stats.toolRunning : currentReply.some(item => item.kind === "thinking" && item.streaming)
      ? zhCN.chat.thinkingReply : zhCN.chat.waitingReply;
  const placeholder = zhCN.chat.placeholder;

  return (
    <section className="chat" data-testid="chat" hidden={hidden}>
      {session && (
        <ChatHeader
          session={session}
          traceOpen={traceOpen ?? false}
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
            <p className="workbench-welcome-copy">{zhCN.chat.welcome}</p>
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
            {!hasMessages ? (
              <EmptyState />
            ) : (
              <Timeline timeline={timeline} />
            )}
            {waitingForReply && <div className="assistant-waiting-status" role="status" data-testid="waiting-reply">{waitingLabel}</div>}
          </div>
        )}
      </div>
      <ConversationMinimap key={session?.id ?? "empty"} timeline={timeline} viewport={bodyRef} onNavigate={timelineId => { followRef.current = false; onNavigateTurn?.(timelineId); }} />
      </div>
      {session && hasMessages && (
        <div className="chat-latest-row">
          {showLatest && (
            <button type="button" className="chat-latest" aria-label={zhCN.chat.latest} title={zhCN.chat.latest} onClick={goToLatest}>
              <span className="chat-latest-face" aria-hidden="true"><Icon name="down" /></span>
            </button>
          )}
        </div>
      )}
      {(session || projects !== null) && (
        <div className="chat-footer">
          <CompactionBanner key={session?.id ?? "no-session"} compaction={compaction} connected={connected} />
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
            onFollowUp={onFollowUp}
            onConfigChange={onConfigChange}
          />
          {session && hasMessages && <StatsBar stats={stats} connected={connected} timeline={timeline} pending={streaming || queued} modelOutput={modelOutput} activeTools={activeTools} />}
        </div>
      )}
    </section>
  );
}
