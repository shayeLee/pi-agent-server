import { zhCN } from "../i18n/zh-CN.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon.js";

import type { ModelInfo, Project, SessionRecord } from "pi-agent-server/client";
import { EMPTY_MESSAGE, type SubmissionState, type SubmitOutcome, type UnsentMessage } from "../attachment-state.js";
import type { DraftSource } from "../draft-store.js";
import { ModelThinkingPicker } from "./ModelThinkingPicker.js";
import { hasVisibleOverlay } from "../lib/overlays.js";

/** Window for the second Esc press (DESIGN.md §5.4). */
export const ABORT_CONFIRM_MS = 1500;

export type ComposerProps = {
  session: SessionRecord | null;
  projects: Project[] | null;
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  canCreateSession: boolean;
  canWrite?: boolean;
  models: ModelInfo[];
  thinkingLevels: string[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: string;
  streaming: boolean;
  queued: boolean;
  primaryAwaitingStart?: boolean;
  historyLoading?: boolean;
  controlsBlocked?: boolean;
  placeholder: string;
  onSend: (text: string) => void | Promise<boolean>;
  draft?: UnsentMessage;
  draftSource?: DraftSource;
  draftScope?: string;
  submission?: SubmissionState | null;
  pendingControls?: Array<{ id: string; kind: "steer" | "followUp"; text: string; status: "submitting" | "submitted" | "unknown" | "failed"; blocking?: boolean }>;
  onDraftText?: (text: string) => void;
  onDraftSettings?: (config: UnsentMessage["settings"]) => void;
  onAddFile?: (file: File) => Promise<void>;
  onRetryFile?: (localId: string) => Promise<void>;
  onRemoveFile?: (localId: string) => void;
  onRetrySubmit?: () => Promise<SubmitOutcome>;
  onConfirmCreation?: () => Promise<SubmitOutcome>;
  onAbort?: () => void;
  /** Reports the first-Esc "press again to abort" window (DESIGN.md §5.4). */
  onAbortArmedChange?: (armed: boolean) => void;
  onFollowUp: (text: string) => void | Promise<boolean>;
  onConfigChange: (config: { modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
};

export function Composer({
  session, canCreateSession, canWrite = true,
  models, thinkingLevels, defaultModel, defaultThinkingLevel,
  streaming, queued, primaryAwaitingStart = false, historyLoading = false, controlsBlocked = false, placeholder, onSend,
  draft: suppliedDraft, draftSource, draftScope = "", submission, pendingControls, onDraftText, onDraftSettings, onAddFile, onRetryFile, onRemoveFile, onRetrySubmit, onConfirmCreation,
  onAbort, onAbortArmedChange, onFollowUp, onConfigChange,
}: ComposerProps) {
  const subscribeDraft = useCallback((listener: () => void) =>
    draftSource?.subscribe(draftScope, listener) ?? (() => {}), [draftSource, draftScope]);
  const getDraft = useCallback(() => draftSource?.getSnapshot(draftScope) ?? suppliedDraft ?? EMPTY_MESSAGE,
    [draftSource, draftScope, suppliedDraft]);
  const snapshot = useSyncExternalStore(subscribeDraft, getDraft, getDraft);
  const draft = draftSource || suppliedDraft ? snapshot : undefined;
  const [dispatching, setDispatching] = useState(false);
  useEffect(() => { setLocalError(null); }, [session?.id, draftScope]);
  const [localText, setLocalText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const text = draft?.text ?? localText;
  const attachments = draft?.attachments ?? [];
  const submitting = submission?.phase === "creating" || submission?.phase === "configuring" || submission?.phase === "submitting";
  const primaryPending = primaryAwaitingStart || submitting || submission?.phase === "unknown";
  const runtimeControls = streaming && !queued && !primaryPending;
  const canAbort = Boolean(onAbort && session && canWrite && streaming && !queued && !historyLoading);
  const [abortArmed, setAbortArmed] = useState(false);
  const armedChange = useRef(onAbortArmedChange);
  armedChange.current = onAbortArmedChange;
  useEffect(() => { armedChange.current?.(abortArmed); }, [abortArmed]);
  useEffect(() => {
    if (!canAbort) { setAbortArmed(false); return; }
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => { clearTimeout(timer); if (armed) { armed = false; setAbortArmed(false); } };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      // Any other key cancels the pending confirmation.
      if (event.key !== "Escape") { disarm(); return; }
      if (event.defaultPrevented || event.repeat) return;
      // Inspector and the mobile drawer also own Escape (they close on it).
      const visibleOverlay = hasVisibleOverlay('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], .app-shell:not(.details-collapsed) [data-testid="inspector"], .mobile-sidebar-open [data-testid="sidebar"], .select-menu[data-open="true"], .model-thinking-picker[data-open="true"]');
      // Overlays own Escape and do not count towards the abort sequence.
      if (visibleOverlay) { disarm(); return; }
      event.preventDefault();
      if (armed) { disarm(); onAbort?.(); return; }
      armed = true;
      setAbortArmed(true);
      clearTimeout(timer);
      timer = setTimeout(disarm, ABORT_CONFIRM_MS);
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", disarm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", disarm);
      setAbortArmed(false);
    };
  }, [canAbort, onAbort]);
  const blockedByAttachment = attachments.some((item) => item.status !== "ready");
  const hasContent = Boolean(text.trim()) || attachments.some((item) => item.status === "ready");
  const controlPending = pendingControls?.some(item => item.blocking !== false && (item.status === "submitting" || item.status === "unknown")) ?? false;
  const attachmentNotice = runtimeControls && attachments.length > 0
    ? attachments.some(item => item.kind !== "image") ? zhCN.composer.followUpFilesUnsupported : null
    : null;
  const canSubmit = canWrite && !historyLoading && !primaryPending && !dispatching && !controlPending && !controlsBlocked && !queued && !attachmentNotice && submission?.phase !== "unknown" && !blockedByAttachment && hasContent &&
    (session !== null || canCreateSession);
  const setText = (value: string) => { if (onDraftText) onDraftText(value); else setLocalText(value); };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Measure content, not the idle space allocated by the flex editor. Otherwise
    // that space becomes a fixed textarea height after content changes.
    el.style.flexGrow = "0";
    el.style.height = "auto";
    const contentHeight = Math.min(el.scrollHeight, 220);
    el.style.height = `${contentHeight}px`;
    el.style.flexGrow = "";
  }, [text]);

  async function handleSubmit() {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setDispatching(true);
    setLocalError(null);
    try {
      if (runtimeControls) {
        if (!session) return;
        await onFollowUp(text.trim());
        // Control owners clear exact snapshots only after the appropriate acknowledgement.
        return;
      }
      const result = onSend(text.trim());
      // Standalone Composer consumers may have a synchronous callback; the controlled
      // editor is cleared only by its owner after an acknowledged submission.
      if (!draft && !(result instanceof Promise)) setLocalText("");
      const accepted = result instanceof Promise ? await result : result;
      if (!draft && accepted !== false) setLocalText("");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : zhCN.composer.sendFailed);
    } finally {
      submittingRef.current = false;
      setDispatching(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void handleSubmit();
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!images.length || !onAddFile) return;
    event.preventDefault();
    images.forEach((file) => void onAddFile(file));
  }

  function chooseFiles(event: React.ChangeEvent<HTMLInputElement>) {
    for (const file of Array.from(event.target.files ?? [])) if (onAddFile) void onAddFile(file);
    event.target.value = "";
  }

  return (
    <div className="composer-stack">
    <div className="composer" data-testid="composer">
      {attachmentNotice && <div className="composer-submit-notice" role="status">{attachmentNotice}</div>}
      {attachments.length > 0 && (
        <div className="composer-attachments" data-testid="composer-attachments" aria-live="polite">
          {attachments.map((item) => (
            <div className="composer-attachment" data-testid="composer-attachment" data-state={item.status} key={item.localId}>
              {item.image ? (
                <img src={item.image.preview} alt="" className="composer-attachment-preview" />
              ) : (
                <Icon name="file" size={13} className="composer-attachment-icon" />
              )}
              <span className="composer-attachment-details">
                <strong title={item.name}>{item.name}</strong>
                <small>{(item.size / 1024).toFixed(0)} KiB</small>
                {item.status === "ready" ? (
                  <span className="sr-only">{zhCN.composer.ready}</span>
                ) : (
                  <small className="composer-attachment-status">
                    · {item.status === "uploading" || item.status === "processing" ? zhCN.composer.processing :
                      item.status === "interrupted" ? zhCN.composer.interrupted : zhCN.composer.failed}
                  </small>
                )}
                {item.error && <small className="composer-attachment-error">{item.error}</small>}
              </span>
              {item.status === "error" && item.file && onRetryFile && (
                <button type="button" onClick={() => void onRetryFile(item.localId)} aria-label={zhCN.composer.retryUpload(item.name)}>{zhCN.composer.retry}</button>
              )}
              {item.status === "interrupted" && (
                <button type="button" onClick={() => { onRemoveFile?.(item.localId); filePickerRef.current?.click(); }}
                  aria-label={zhCN.composer.reselectAttachment(item.name)}>{zhCN.composer.reselect}</button>
              )}
              <button type="button" className="composer-attachment-remove" onClick={() => onRemoveFile?.(item.localId)} aria-label={zhCN.composer.removeAttachment(item.name)} title={zhCN.composer.remove}><Icon name="close" size={11} /></button>
            </div>
          ))}
        </div>
      )}
      {pendingControls && pendingControls.length > 0 && (
        <div className="composer-pending-controls" data-testid="composer-pending-controls" aria-live="polite">
          {pendingControls.map((item) => <div className="composer-pending-item" key={item.id}>
            <span>{item.kind === "steer" ? zhCN.composer.steerSubmission : zhCN.composer.followUpSubmission} · {item.text}</span>
            <small>{item.status === "submitting" ? zhCN.composer.submitting : item.status === "submitted" ? (item.kind === "steer" ? zhCN.composer.accepted : zhCN.composer.confirmationPending) :
              item.status === "unknown" ? zhCN.steps.unknown : zhCN.composer.submissionFailed}</small>
          </div>)}
        </div>
      )}
      {(submission?.phase === "failed" || submission?.phase === "unknown" || localError) && (
        <div className="composer-submit-notice" role="alert" data-testid="composer-submit-notice">
          {submission?.phase === "unknown"
            ? submission.stage === "create" ? zhCN.composer.creationUnknown : zhCN.composer.submissionUnknown
            : submission?.error ?? localError}
          {submission?.phase === "failed" && onRetrySubmit && (
            <button type="button" onClick={() => void onRetrySubmit()} data-testid="retry-submission">{zhCN.composer.retrySnapshot}</button>
          )}
          {submission?.phase === "unknown" && submission.stage === "create" && onConfirmCreation && (
            <button type="button" onClick={() => void onConfirmCreation()} data-testid="confirm-creation">{zhCN.composer.confirmCreation}</button>
          )}
        </div>
      )}
      <textarea ref={textareaRef} data-testid="composer-input" rows={1} placeholder={runtimeControls ? zhCN.run.runningPlaceholder : placeholder}
        aria-label={zhCN.composer.message} title={canAbort ? zhCN.composer.queueKeyboardHint : zhCN.composer.sendKeyboardHint} value={text}
        onChange={(event) => setText(event.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
        disabled={!canWrite || historyLoading} />
      <div className="composer-toolbar">
        <div className="composer-left">
          <input ref={filePickerRef} type="file" multiple className="composer-file-input"
            data-testid="composer-file-input" aria-label={zhCN.composer.chooseFiles} onChange={chooseFiles} />
          <button type="button" className="composer-add" aria-label={zhCN.composer.addAttachment} title={zhCN.composer.addFiles}
            onClick={() => filePickerRef.current?.click()} disabled={!canWrite || !onAddFile || historyLoading}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="composer-right">
          <ModelThinkingPicker models={models} thinkingLevels={thinkingLevels} defaultModel={defaultModel}
            defaultThinkingLevel={defaultThinkingLevel}
            modelProvider={session ? session.modelProvider : draft?.settings.modelProvider ?? null}
            modelId={session ? session.modelId : draft?.settings.modelId ?? null}
            thinkingLevel={session ? session.thinkingLevel : draft?.settings.thinkingLevel ?? null}
            onConfigChange={session ? onConfigChange : (config) => onDraftSettings?.(config)} />
          <span className={`composer-hint${abortArmed ? " is-armed" : ""}`} data-testid="composer-hint" aria-hidden="true">
            {abortArmed ? zhCN.run.pressEscAgain : canAbort ? `${zhCN.run.appendHint} · ${zhCN.run.abortKeyHint}` : zhCN.run.newlineHint}
          </span>
          {canAbort ? <button type="button" className="send-button" data-testid="abort-button"
            onClick={onAbort} aria-label={zhCN.composer.abort} title={zhCN.composer.abortHint}>
            <span className="send-button-visual">{zhCN.run.abortLabel}</span>
          </button> : <button type="button" className="send-button" data-testid="send-button" onClick={() => void handleSubmit()}
            disabled={!canSubmit} aria-label={zhCN.composer.send} title={runtimeControls ? zhCN.composer.queue : zhCN.composer.send}>
            <span className="send-button-visual">{zhCN.run.sendLabel}</span>
          </button>}
        </div>
      </div>
    </div>
    </div>
  );
}
