import { zhCN } from "../i18n/zh-CN.js";
import { useState } from "react";
import { Icon } from "./Icon.js";
import type { TimelineItem } from "pi-agent-server/client";
import { previewText } from "./ledger.js";

export type ThinkingRowProps = {
  thinking: Extract<TimelineItem, { kind: "thinking" }>;
  /** Render as an unnumbered step row inside a work block. */
  step?: boolean;
};

export function ThinkingRow({ thinking, step = false }: ThinkingRowProps) {
  // Starts collapsed, streaming or not; only the reader opens it.
  const [visible, setVisible] = useState(false);
  // Keep hooks and manual state mounted for this id, even before useful text arrives.
  if (!thinking.text.trim()) return null;

  return (
    <div
      className={`message-row thinking-row${step ? " thinking-step" : ""} ${thinking.streaming ? "streaming" : ""}`}
      data-expanded={visible}
      data-testid={`thinking-${thinking.id}`}
    >
      <button
        type="button"
        className="thinking-header chevron-trigger"
        onClick={() => setVisible(!visible)}
        aria-expanded={visible}
        aria-label={zhCN.thinking.label}
        title={visible ? zhCN.thinking.collapse : zhCN.thinking.expand}
      >
        {step && <span className="step-index" aria-hidden="true" />}
        {step && <span className="thinking-glyph" aria-hidden="true">·</span>}
        <span className="thinking-label">{thinking.streaming ? zhCN.thinking.thinking : zhCN.thinking.thought}</span>
        {!visible && <span className="thinking-preview">{previewText(thinking.text)}</span>}
        <Icon name="chevron" className="disclosure-chevron thinking-chevron" />
      </button>
      {visible && (
        <div className="thinking-body" data-testid={`thinking-body-${thinking.id}`}>
          {thinking.text}
          {thinking.streaming && <span className="streaming-cursor ledger-caret" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}
