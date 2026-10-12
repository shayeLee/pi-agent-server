import { memo, useEffect, useRef, useState } from "react";
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
export const ToolCallCard = memo(function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(!call.done);
  const userToggled = useRef(false);
  useEffect(() => {
    if (!userToggled.current) setExpanded(!call.done);
  }, [call.done]);
  const duration = call.done ? formatToolDuration(call.durationMs) : null;
  const durationTitle = `工具调用耗时：${call.durationMs} ms${call.toolName === "subagent_wait" ? "（本次 wait 调用，非子 agent 运行时长）" : ""}`;
  const status = call.done ? (call.isError ? "失败" : "已完成") : "进行中";
  const { header, Arguments, Result } = toolPresentation(call);
  const { summary, badge, priorityLabels, preview } = header;

  return (
    <div
      className={`tool-call ${call.done ? "tool-done" : "tool-running"} ${call.isError ? "tool-error" : ""}`}
      data-testid="tool-call-card"
      data-tool-call-id={call.toolCallId}
      data-done={String(call.done)}
    >
      <div className="tool-call-heading">
      <button
        type="button"
        className={`tool-call-header chevron-trigger${badge ? " tool-parallel-header" : ""}`}
        onClick={() => {
          userToggled.current = true;
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        aria-label={`工具调用 ${call.toolName}，状态：${status}`} title={call.toolName}
      >
        <ToolStatusIcon done={call.done} isError={call.isError} />
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
            <Result label="结果" value={call.result} args={call.args} />
          ) : call.partialResult !== undefined ? (
            <Result label="部分结果" value={call.partialResult} args={call.args} />
          ) : null}
        </div>
      )}
    </div>
  );
});
