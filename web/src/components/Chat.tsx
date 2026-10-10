import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { ChatState, ModelInfo, Project, SessionRecord, UsageStats } from "pi-agent-server/client";
import { Timeline } from "./Timeline.js";
import type { DraftSource } from "../draft-store.js";
import { Composer } from "./Composer.js";
import { CompactionBanner, type CompactionState } from "./CompactionBanner.js";
import { StatsBar } from "./StatsBar.js";
import { ChatHeader } from "./ChatHeader.js";
import { EmptyState } from "./EmptyState.js";
import type { SubmissionState, SubmitOutcome, UnsentMessage } from "../attachment-state.js";
import { useI18n } from "../i18n/I18nProvider.js";
import { ChatHistorySkeleton } from "./WorkspaceSkeleton.js";

export type ChatProps = {
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
  pendingControls?: Array<{ id: string; kind: "steer" | "followUp"; text: string; status: "submitting" | "submitted" | "unknown" | "failed" }>;
  onDraftText?: (text: string) => void;
  onDraftSettings?: (config: UnsentMessage["settings"]) => void;
  onAddFile?: (file: File) => Promise<void>;
  onRetryFile?: (localId: string) => Promise<void>;
  onRemoveFile?: (localId: string) => void;
  onRetrySubmit?: () => Promise<SubmitOutcome>;
  onConfirmCreation?: () => Promise<SubmitOutcome>;
  onSteer: (text: string) => void;
  onFollowUp: (text: string) => void;
  onAbort: () => void;
  onToggleDetails: () => void;
  onSelectTab?: (tab: "chat" | "trace") => void;
  traceActive?: boolean;
  onConfigChange: (config: { modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
};

export function Chat({
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
  pendingControls,
  onDraftText,
  onDraftSettings,
  onAddFile,
  onRetryFile,
  onRemoveFile,
  onRetrySubmit,
  onConfirmCreation,
  onSteer,
  onFollowUp,
  onAbort,
  onToggleDetails,
  onSelectTab,
  traceActive,
  onConfigChange,
}: ChatProps) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [localTraceActive, setLocalTraceActive] = useState(false);
  const activeTraceTab = traceActive ?? localTraceActive;
  const selectTab = (tab: "chat" | "trace") => {
    if (onSelectTab) onSelectTab(tab);
    else setLocalTraceActive(tab === "trace");
  };

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
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const node = bodyRef.current;
      if (followRef.current && node) node.scrollTop = node.scrollHeight;
    });
    remember(el);
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
    let frame = 0;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
      // Scroll anchoring can undo the pin after paint. One frame later, pin again.
      frame = requestAnimationFrame(() => {
        const node = bodyRef.current;
        if (followRef.current && node) node.scrollTop = node.scrollHeight;
      });
    }
    remember(el);
    return () => cancelAnimationFrame(frame);
  }, [session?.id, historyLoading, timeline]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // Includes images, asynchronous highlighting, and viewport/Composer resize.
      if (followRef.current && !initialHistoryRef.current) {
        el.scrollTop = el.scrollHeight;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (followRef.current && !initialHistoryRef.current) el.scrollTop = el.scrollHeight;
        });
      }
      remember(el);
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [session?.id]);

  const hasMessages = timeline.length > 0;
  const placeholder = t("chat.placeholder");

  return (
    <section className="chat col-start-2 row-start-1 flex h-full min-w-0 flex-col overflow-hidden bg-background max-[1179px]:col-auto max-[1179px]:h-dvh max-[1179px]:w-full" data-testid="chat">
      {session && (
        <ChatHeader
          session={session}
          traceActive={activeTraceTab}
          toolCount={timeline.filter((item) => item.kind === "tool").length}
          onToggleDetails={onToggleDetails}
          onSelectTab={selectTab}
        />
      )}
      <div className="chat-body min-h-0 flex-1 overflow-y-auto bg-background outline-none focus:outline-none focus-visible:outline-none" ref={bodyRef} data-testid="chat-body"
        role="region" aria-label={t("chat.region")} tabIndex={0}
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
            {loadError && <div className="chat-phase-banner error mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert">{loadError}</div>}
            <p className="workbench-welcome-title mb-2 text-[20px] font-medium leading-snug text-foreground">{t("chat.welcomeTitle")}</p>
            <p className="workbench-welcome-copy text-[15px] leading-relaxed text-foreground">{t("chat.welcome")}</p>
          </div>
        ) : (
          <div className="chat-inner">
            {historyNotice && <div className="chat-history-notice" role="status">{historyNotice}</div>}
            {loadError && (
              <div className="chat-phase-banner error rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive" data-testid="load-error">
                {loadError}
              </div>
            )}
            {historyLoading && !hasMessages ? (
              <ChatHistorySkeleton />
            ) : (
              <>
                {queued && (
                  <div className="chat-phase-banner queued rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-[13px] text-muted-foreground" data-testid="phase-queued">
                    {t("chat.queued")}
                  </div>
                )}
                {!hasMessages ? (
                  <EmptyState />
                ) : (
                  <Timeline timeline={timeline} />
                )}
              </>
            )}
          </div>
        )}
      </div>
      {session && hasMessages && (
        <div className="chat-latest-row flex h-[44px] shrink-0 items-center justify-center bg-background">
          {showLatest && (
            <button type="button" className="chat-latest grid h-[44px] w-[44px] place-items-center bg-transparent text-muted-foreground outline-none" aria-label={t("chat.scrollLatest")} title={t("chat.scrollLatest")} onClick={goToLatest}>
              <span className="chat-latest-face grid size-[34px] place-items-center rounded-full border border-border bg-card shadow-sm" aria-hidden="true"><Icon name="down" /></span>
            </button>
          )}
        </div>
      )}
      {(session || projects !== null) && (
        <div className="chat-footer">
          <CompactionBanner key={session?.id ?? "no-session"} compaction={compaction} connected={connected} />
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
            historyLoading={historyLoading}
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
            onSteer={onSteer}
            onFollowUp={onFollowUp}
            onAbort={onAbort}
            onConfigChange={onConfigChange}
          />
          {session && hasMessages && <StatsBar stats={stats} connected={connected} timeline={timeline} pending={streaming || queued} modelOutput={modelOutput} activeTools={activeTools} />}
        </div>
      )}
    </section>
  );
}
