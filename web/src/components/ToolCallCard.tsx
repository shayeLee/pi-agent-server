import { useState } from "react";
import type { ToolCall } from "../types.js";

/** 把 unknown 值转成可读文本：字符串原样展示，其它 JSON 美化序列化。 */
export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 一块可折叠的 JSON 区块。 */
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className="json-block">
      <div className="json-label">{label}</div>
      <pre className="json-value">{stringify(value)}</pre>
    </div>
  );
}

/**
 * 一次工具调用的流式卡片。
 * tool_start → 创建（done=false，展示 args）；tool_update → 流式 partialResult；
 * tool_end → 展示 result 并标记完成（done=true）。
 */
export function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`tool-call ${call.done ? "tool-done" : "tool-running"} ${call.isError ? "tool-error" : ""}`}
      data-testid="tool-call-card"
      data-tool-call-id={call.toolCallId}
      data-done={String(call.done)}
    >
      <button
        className="tool-call-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tool-indicator">{call.done ? "✓" : "⟳"}</span>
        <span className="tool-name" data-testid="tool-name">
          {call.toolName}
        </span>
        {call.done && call.isError && <span className="tool-badge tool-error-badge">失败</span>}
        {!call.done && <span className="tool-badge tool-running-badge">运行中</span>}
        <span className="tool-toggle">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="tool-call-body">
          <JsonBlock label="参数" value={call.args} />
          {call.done ? (
            <JsonBlock label="结果" value={call.result} />
          ) : call.partialResult !== undefined ? (
            <JsonBlock label="部分结果" value={call.partialResult} />
          ) : null}
        </div>
      )}
    </div>
  );
}
