import { zhCN } from "../i18n/zh-CN.js";
import { useState } from "react";
import { Icon } from "./Icon.js";
import type { TimelineItem } from "pi-agent-server/client";

export type ThinkingRowProps = {
  thinking: Extract<TimelineItem, { kind: "thinking" }>;
};

export function ThinkingRow({ thinking }: ThinkingRowProps) {
  // Streaming opens by default, but an explicit user choice can still collapse it.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const visible = manualExpanded ?? thinking.streaming;
  // Keep hooks and manual state mounted for this id, even before useful text arrives.
  if (!thinking.text.trim()) return null;

  return (
    <div
      className={`message-row thinking-row ${thinking.streaming ? "streaming" : ""}`}
      data-expanded={visible}
      data-testid={`thinking-${thinking.id}`}
    >
      <button
        type="button"
        className="thinking-header chevron-trigger"
        onClick={() => setManualExpanded(!visible)}
        aria-expanded={visible}
        aria-label={zhCN.thinking.label}
        title={visible ? zhCN.thinking.collapse : zhCN.thinking.expand}
      >
        <span className="thinking-label">{thinking.streaming ? zhCN.thinking.thinking : zhCN.thinking.thought}</span>
        <Icon name="chevron" className="disclosure-chevron thinking-chevron" />
      </button>
      {visible && (
        <div className="thinking-body" data-testid={`thinking-body-${thinking.id}`}>
          {thinking.text}
          {thinking.streaming && <Icon name="dot" className="streaming-cursor" />}
        </div>
      )}
    </div>
  );
}
