import { zhCN } from "../i18n/zh-CN.js";
import type { ToolCall } from "pi-agent-server/client";
import { Icon } from "./Icon.js";
import { formatToolDuration } from "../tools/duration.js";

const GLYPHS: Record<string, string> = { running: "◐", ok: "✓", error: "✗", unfinished: "…" };

/** 一次工具调用在运行中发起的调用（codemode 脚本里的 MCP 调用等），默认折叠。 */
export function NestedToolCalls({ nested }: { nested: NonNullable<ToolCall["nested"]> }) {
  const { calls, complete } = nested;
  if (calls.length === 0 && complete) return null;
  return <details className="nested-tool-calls" data-testid="nested-tool-calls">
    <summary className="nested-tool-calls-summary chevron-trigger">
      <Icon name="chevron" className="details-chevron disclosure-chevron" />
      <span>{zhCN.nestedCalls.summary(calls.length)}</span>
      {!complete && <span className="nested-tool-calls-incomplete">{zhCN.nestedCalls.incomplete}</span>}
    </summary>
    <ol className="nested-tool-call-list" aria-label={zhCN.nestedCalls.label}>
      {calls.map(call => {
        const duration = formatToolDuration(call.durationMs);
        const status = zhCN.nestedCalls.status[call.status] ?? call.status;
        return <li key={call.id} className={`nested-tool-call nested-tool-call-${call.status}`} data-testid="nested-tool-call">
          <span className={`nested-tool-call-status tool-status-${call.status === "ok" ? "success" : call.status}`} role="img" aria-label={status} title={status}>{GLYPHS[call.status] ?? "·"}</span>
          <span className="nested-tool-call-name">{call.name}</span>
          {duration !== null && <span className="tool-duration">{duration}</span>}
          {call.error && <span className="nested-tool-call-error">{call.error}</span>}
          {call.argumentsBytes !== undefined && call.arguments === undefined && <span className="nested-tool-call-note">{zhCN.nestedCalls.argumentsOmitted(call.argumentsBytes)}</span>}
        </li>;
      })}
    </ol>
  </details>;
}
