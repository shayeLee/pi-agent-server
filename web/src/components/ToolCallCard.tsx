import type { ToolCall } from "../types.js";

/** 把 unknown 值转成可读文本：字符串原样展示，其它 JSON 序列化。 */
function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * 一次工具调用的流式卡片（可折叠 details）。
 * tool_start → 创建（done=false）；tool_update → 流式 partialResult；
 * tool_end → 展示 result 并标记完成（done=true）。
 */
export function ToolCallCard({ call }: { call: ToolCall }) {
  return (
    <details
      data-testid="tool-call-card"
      data-tool-call-id={call.toolCallId}
      data-done={String(call.done)}
    >
      <summary>
        <span data-testid="tool-name">{call.toolName}</span>
        {call.done && <span data-testid="tool-done">✓ 完成</span>}
        {call.isError && <span data-testid="tool-error">失败</span>}
      </summary>
      <div data-testid="tool-args">参数：{stringify(call.args)}</div>
      {call.done ? (
        <div data-testid="tool-result">结果：{stringify(call.result)}</div>
      ) : call.partialResult !== undefined ? (
        <div data-testid="tool-partial">{stringify(call.partialResult)}</div>
      ) : null}
    </details>
  );
}