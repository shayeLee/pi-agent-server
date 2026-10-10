import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon.js";

import type { ModelInfo, Project, SessionRecord } from "pi-agent-server/client";
import { EMPTY_MESSAGE, type SubmissionState, type SubmitOutcome, type UnsentMessage } from "../attachment-state.js";
import type { DraftSource } from "../draft-store.js";
import { ModelThinkingPicker } from "./ModelThinkingPicker.js";
import { SelectMenu } from "./SelectMenu.js";
import { useI18n } from "../i18n/I18nProvider.js";

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
  historyLoading?: boolean;
  placeholder: string;
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
  onConfigChange: (config: { modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
};

export function Composer({
  session, projects, activeProjectId, onSelectProject, canCreateSession, canWrite = true,
  models, thinkingLevels, defaultModel, defaultThinkingLevel,
  streaming, queued, historyLoading = false, placeholder, onSend,
  draft: suppliedDraft, draftSource, draftScope = "", submission, pendingControls, onDraftText, onDraftSettings, onAddFile, onRetryFile, onRemoveFile, onRetrySubmit, onConfirmCreation,
  onSteer, onFollowUp, onAbort, onConfigChange,
}: ComposerProps) {
  const { t } = useI18n();
  const subscribeDraft = useCallback((listener: () => void) =>
    draftSource?.subscribe(draftScope, listener) ?? (() => {}), [draftSource, draftScope]);
  const getDraft = useCallback(() => draftSource?.getSnapshot(draftScope) ?? suppliedDraft ?? EMPTY_MESSAGE,
    [draftSource, draftScope, suppliedDraft]);
  const snapshot = useSyncExternalStore(subscribeDraft, getDraft, getDraft);
  const draft = draftSource || suppliedDraft ? snapshot : undefined;
  const [localText, setLocalText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const text = draft?.text ?? localText;
  const attachments = draft?.attachments ?? [];
  const submitting = submission?.phase === "creating" || submission?.phase === "configuring" || submission?.phase === "submitting";
  const blockedByAttachment = attachments.some((item) => item.status !== "ready");
  const hasContent = Boolean(text.trim()) || attachments.some((item) => item.status === "ready");
  const canSubmit = canWrite && !historyLoading && !submitting && submission?.phase !== "unknown" && !blockedByAttachment && hasContent &&
    (session !== null || canCreateSession);
  const projectOptions = (projects ?? []).map((project) => ({ value: project.id, label: project.name }));
  const projectSelectionAvailable = projects !== null && activeProjectId !== null && projects.some((project) => project.id === activeProjectId);
  const setText = (value: string) => { if (onDraftText) onDraftText(value); else setLocalText(value); };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  async function handleSubmit() {
    if (!canSubmit || submittingRef.current || streaming || queued) return;
    submittingRef.current = true;
    setLocalError(null);
    try {
      const result = onSend(text.trim());
      // Standalone Composer consumers may have a synchronous callback; the controlled
      // editor is cleared only by its owner after an acknowledged submission.
      if (!draft && !(result instanceof Promise)) setLocalText("");
      const accepted = result instanceof Promise ? await result : result;
      if (!draft && accepted !== false) setLocalText("");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "发送失败");
    } finally {
      submittingRef.current = false;
    }
  }

  function submitControl(kind: "steer" | "followUp") {
    const value = text.trim();
    if (!canWrite || !session || !streaming || queued || !hasContent || submitting || blockedByAttachment) return;
    if (kind === "steer") onSteer(value);
    else onFollowUp(value);
    if (kind === "followUp") setText("");
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (streaming && !queued) submitControl("steer");
    else void handleSubmit();
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
    <div className="composer" data-testid="composer">
      {!session && (
        <div className="composer-start-settings" data-testid="composer-start-settings">
          <SelectMenu className="composer-project-picker" options={projectOptions} value={activeProjectId ?? ""}
            onChange={onSelectProject} ariaLabel={t("nav.selectProject")} disabled={!projectSelectionAvailable} testId="composer-project-select" />
          <ModelThinkingPicker models={models} thinkingLevels={thinkingLevels} defaultModel={defaultModel}
            defaultThinkingLevel={defaultThinkingLevel}
            modelProvider={draft?.settings.modelProvider ?? null} modelId={draft?.settings.modelId ?? null}
            thinkingLevel={draft?.settings.thinkingLevel ?? null} onConfigChange={(config) => onDraftSettings?.(config)} />
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments" data-testid="composer-attachments" aria-live="polite">
          {attachments.map((item) => (
            <div className="composer-attachment" data-testid="composer-attachment" data-state={item.status} key={item.localId}>
              {item.image && <img src={item.image.preview} alt="" className="composer-attachment-preview" />}
              <span className="composer-attachment-details">
                <strong title={item.name}>{item.name}</strong>
                <small>{(item.size / 1024).toFixed(0)} KiB · {item.mediaType || item.kind} · {
                  item.status === "ready" ? t("composer.attachment.ready") : item.status === "uploading" || item.status === "processing" ? t("composer.attachment.processing") :
                    item.status === "interrupted" ? t("composer.attachment.interrupted") : t("composer.attachment.failed")}</small>
                {item.error && <small className="composer-attachment-error">{item.error}</small>}
              </span>
              {item.status === "error" && item.file && onRetryFile && (
                <button type="button" onClick={() => void onRetryFile(item.localId)} aria-label={`${t("composer.attachment.retry")} ${item.name}`}>{t("composer.attachment.retry")}</button>
              )}
              {item.status === "interrupted" && (
                <button type="button" onClick={() => { onRemoveFile?.(item.localId); filePickerRef.current?.click(); }}
                  aria-label={`${t("composer.attachment.repick")} ${item.name}`}>{t("composer.attachment.repick")}</button>
              )}
              <button type="button" onClick={() => onRemoveFile?.(item.localId)} aria-label={`${t("composer.attachment.remove")} ${item.name}`}><Icon name="close" /></button>
            </div>
          ))}
        </div>
      )}
      {pendingControls && pendingControls.length > 0 && (
        <div className="composer-pending-controls" data-testid="composer-pending-controls" aria-live="polite">
          {pendingControls.map((item) => <div className="composer-pending-item" key={item.id}>
            <span>{item.kind === "steer" ? t("composer.pending.steer") : t("composer.pending.followUp")} · {item.text}</span>
            <small>{item.status === "submitting" ? t("composer.pending.submitting") : item.status === "submitted" ? (item.kind === "steer" ? t("composer.pending.steerAck") : t("composer.pending.followUpAck")) :
              item.status === "unknown" ? t("composer.pending.unknown") : t("composer.pending.failed")}</small>
          </div>)}
        </div>
      )}
      {(submission?.phase === "failed" || submission?.phase === "unknown" || localError) && (
        <div className="composer-submit-notice" role="alert" data-testid="composer-submit-notice">
          {submission?.phase === "unknown"
            ? submission.stage === "create" ? t("composer.unknown.create") : t("composer.unknown.send")
            : submission?.error ?? localError}
          {submission?.phase === "failed" && onRetrySubmit && (
            <button type="button" onClick={() => void onRetrySubmit()} data-testid="retry-submission">{t("composer.retrySnapshot")}</button>
          )}
          {submission?.phase === "unknown" && submission.stage === "create" && onConfirmCreation && (
            <button type="button" onClick={() => void onConfirmCreation()} data-testid="confirm-creation">{t("composer.confirmCreation")}</button>
          )}
        </div>
      )}
      <textarea ref={textareaRef} data-testid="composer-input" rows={1} placeholder={placeholder}
        aria-label={t("chat.placeholder")} title={t("chat.composerHint")} value={text}
        onChange={(event) => setText(event.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
        disabled={!canWrite || historyLoading} />
      <div className="composer-toolbar">
        <div className="composer-left">
          <input ref={filePickerRef} type="file" multiple className="composer-file-input"
            data-testid="composer-file-input" aria-label={t("composer.pickFiles")} onChange={chooseFiles} />
          <button type="button" className="composer-add" aria-label={t("composer.addAttachment")} title={t("composer.addAttachment")}
            onClick={() => filePickerRef.current?.click()} disabled={!canWrite || !onAddFile || historyLoading}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="composer-right">
          {session && (streaming || queued) && (
            <>
              <button type="button" className="composer-control" onClick={() => submitControl("steer")}
                disabled={!canWrite || !streaming || queued || !text.trim()} aria-label={t("composer.steer")}>{t("composer.steer")}</button>
              <button type="button" className="composer-control" onClick={() => submitControl("followUp")}
                disabled={!canWrite || !streaming || queued || !text.trim()}
                title={queued ? t("composer.followUpQueuedHint") : t("composer.followUpTitle")} aria-label={t("composer.followUp")}>{t("composer.followUp")}</button>
            </>
          )}
          {streaming ? (
            <button type="button" className="composer-stop" data-testid="abort-button" aria-label={t("composer.stop")} title={t("composer.stop")} onClick={onAbort}>
              <Icon name="stop" />
            </button>
          ) : (
            <>
              {session && <ModelThinkingPicker models={models} thinkingLevels={thinkingLevels} defaultModel={defaultModel}
                defaultThinkingLevel={defaultThinkingLevel} modelProvider={session.modelProvider} modelId={session.modelId}
                thinkingLevel={session.thinkingLevel} onConfigChange={onConfigChange} />}
              <button type="button" className="send-button" data-testid="send-button" onClick={() => void handleSubmit()}
                disabled={!canSubmit || queued} aria-label={t("composer.send")}>
                <Icon name="send" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
