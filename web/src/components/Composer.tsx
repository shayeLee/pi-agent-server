import { useState } from "react";

export type ComposerProps = {
  /** 是否正在流式输出（流式时用 steer/abort 取代发送按钮）。 */
  streaming: boolean;
  /** 是否排队等待（排队只可 abort，不接受 steer）。 */
  queued?: boolean;
  onSend: (text: string) => void;
  onSteer?: (text: string) => void;
  onAbort?: () => void;
};

/** 输入框 + 发送按钮；流式时提供 steer（转向）/abort（中止）。 */
export function Composer({ streaming, queued, onSend, onSteer, onAbort }: ComposerProps) {
  const [text, setText] = useState("");

  function submit(): void {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  }

  return (
    <div data-testid="composer">
      <textarea
        data-testid="composer-input"
        aria-label="消息输入"
        value={text}
        placeholder="输入消息…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {streaming ? (
        <>
          {queued ? null : (
            <button data-testid="steer-button" onClick={() => onSteer?.(text.trim())}>
              转向
            </button>
          )}
          <button data-testid="abort-button" onClick={() => onAbort?.()}>
            中止
          </button>
        </>
      ) : (
        <button data-testid="send-button" onClick={submit}>
          发送
        </button>
      )}
    </div>
  );
}