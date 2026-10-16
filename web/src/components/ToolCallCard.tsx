import { zhCN } from "../i18n/zh-CN.js";
import { memo, useState } from "react";
import { ToolStatusIcon } from "./ToolStatusIcon.js";
import { Icon } from "./Icon.js";
import type { ToolCall } from "pi-agent-server/client";
import { formatToolDuration } from "../tools/duration.js";
import { toolPresentation } from "../tools/presentation.js";

/**
 * 一次工具调用的流式卡片。
 * tool_start → 创建（done=false，展示 args）；tool_update → 流式 partialResult；
 * tool_end → 展示 result 并标记完成（done=true）。
 */
/** With `index`, renders as a numbered Ledger step row inside a work block (DESIGN.md §4.5). */
/** Every tool starts collapsed; only the reader opens it. */
export const ToolCallCard = memo(function ToolCallCard({ call, index }: { call: ToolCall; index?: number }) {
  const [expanded, setExpanded] = useState(false);
  const duration = call.done ? formatToolDuration(call.durationMs) : null;
  const durationTitle = zhCN.toolCall.duration(call.durationMs, call.toolName === "subagent_wait" ? zhCN.toolCall.waitScope : "");
  const status = call.done ? (call.isError ? zhCN.composer.failed : zhCN.status.completed) : zhCN.steps.streaming;
  const { header, Arguments, Result } = toolPresentation(call);
  const { summary, badge, priorityLabels, preview } = header;

  return (
    <div
      className={`tool-call ${index !== undefined ? "tool-step " : ""}${call.done ? "tool-done" : "tool-running"} ${call.isError ? "tool-error" : ""}`}
      data-testid="tool-call-card"
      data-tool-call-id={call.toolCallId}
      data-done={String(call.done)}
    >
      <div className="tool-call-heading">
      <button
        type="button"
        className={`tool-call-header chevron-trigger${badge ? " tool-parallel-header" : ""}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={zhCN.toolCall.label(call.toolName, status)} title={call.toolName}
      >
        {index !== undefined && <span className="step-index" aria-hidden="true">{String(index).padStart(2, "0")}</span>}
        <ToolStatusIcon done={call.done} isError={call.isError} glyph={index !== undefined} />
        <span className="tool-name" data-testid="tool-name" title={call.toolName}>
          {call.toolName}
        </span>
        {badge && <span className="tool-parallel-count">{badge}</span>}
        {summary && <span className="tool-summary-preview" title={summary}>{priorityLabels
          ? <><span className="tool-parallel-names">{priorityLabels.join("、")}</span><span className="tool-parallel-preview">{preview}</span></>
          : summary}</span>}
        <span className="tool-header-icons">
          {duration !== null && <span className="tool-duration" title={durationTitle} aria-label={durationTitle}>{duration}</span>}
          <Icon name={expanded ? "down" : "chevron"} className="disclosure-chevron tool-toggle" />
        </span>
      </button>
      </div>
      {expanded && (
        <div className="tool-call-body">
          <Arguments value={call.args} args={call.args} />
          {call.done ? (
            <Result label={zhCN.toolCall.result} value={call.result} args={call.args} />
          ) : call.partialResult !== undefined ? (
            <Result label={zhCN.toolCall.partialResult} value={call.partialResult} args={call.args} />
          ) : null}
        </div>
      )}
    </div>
  );
});
