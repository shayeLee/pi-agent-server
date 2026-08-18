import { useEffect, useRef, useState } from "react";

import type { ModelInfo, SessionRecord } from "../types.js";

export type ComposerProps = {
  session: SessionRecord | null;
  models: ModelInfo[];
  thinkingLevels: string[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: string;
  streaming: boolean;
  queued: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onFollowUp: (text: string) => void;
  onAbort: () => void;
  onConfigChange: (config: { modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
};

export function Composer({
  session,
  models,
  thinkingLevels,
  defaultModel,
  defaultThinkingLevel,
  streaming,
  queued,
  placeholder,
  onSend,
  onSteer,
  onFollowUp,
  onAbort,
  onConfigChange,
}: ComposerProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (streaming) {
      onSteer(trimmed);
    } else if (queued) {
      onFollowUp(trimmed);
    } else {
      onSend(trimmed);
    }
    setText("");
  }

  const sendDisabled = !text.trim() || queued;
  const defaultModelValue = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : "";
  const configuredModelValue =
    session?.modelProvider && session.modelId ? `${session.modelProvider}/${session.modelId}` : undefined;
  const modelValue = configuredModelValue ?? defaultModelValue;
  const thinkingValue = session?.thinkingLevel ?? defaultThinkingLevel;

  return (
    <div className="composer" data-testid="composer">
      <textarea
        ref={textareaRef}
        data-testid="composer-input"
        rows={1}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={queued}
      />
      <div className="composer-toolbar">
        <div className="composer-left" />
        <div className="composer-right">
          {streaming ? (
            <button
              type="button"
              className="btn-danger"
              data-testid="abort-button"
              onClick={onAbort}
            >
              中止
            </button>
          ) : (
            <>
              {session && (
                <>
                  <select
                    className="composer-model"
                    data-testid="composer-model"
                    aria-label="选择模型"
                    value={modelValue}
                    onChange={(e) => {
                      const [provider, id] = e.target.value.split("/");
                      if (provider && id) onConfigChange({ modelProvider: provider, modelId: id });
                    }}
                  >
                    <option value={defaultModelValue}>
                      {defaultModel
                        ? `${defaultModel.provider} / ${defaultModel.id}`
                        : "默认模型"}
                    </option>
                    {models
                      .filter((m) => `${m.provider}/${m.id}` !== defaultModelValue)
                      .map((m) => (
                        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                          {m.provider} / {m.name}
                        </option>
                      ))}
                  </select>
                  <select
                    className="composer-model"
                    data-testid="composer-thinking"
                    aria-label="选择思考级别"
                    value={thinkingValue}
                    onChange={(e) => onConfigChange({ thinkingLevel: e.target.value || undefined })}
                  >
                    <option value={defaultThinkingLevel}>{defaultThinkingLevel}</option>
                    {thinkingLevels
                      .filter((l) => l !== defaultThinkingLevel)
                      .map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                  </select>
                </>
              )}
              <button
                type="button"
                className="send-button"
                data-testid="send-button"
                onClick={handleSubmit}
                disabled={sendDisabled}
                aria-label="发送"
              >
                ↑
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
