import { zhCN } from "../i18n/zh-CN.js";
import type { ChatPhase } from "pi-agent-server/client";

const PHASE_LABEL: Record<ChatPhase, string> = {
  idle: zhCN.status.idle,
  submitting: zhCN.status.submitting,
  queued: zhCN.status.queued,
  streaming: zhCN.status.streaming,
  completed: zhCN.status.completed,
  aborted: zhCN.steps.aborted,
};

export type StatusBarProps = {
  phase: ChatPhase;
  messageCount: number;
  toolCount: number;
  connected: boolean;
};

/** 底部状态栏：任务阶段 + 消息/工具计数 + 连接状态。 */
export function StatusBar({ phase, messageCount, toolCount, connected }: StatusBarProps) {
  return (
    <footer className="status-bar" data-testid="status-bar">
      <span className="phase-badge" data-phase={phase} data-testid="phase-badge">
        {PHASE_LABEL[phase]}
      </span>
      <span data-testid="status-counts">
        {zhCN.status.messages} {messageCount}  {zhCN.status.toolCount} {toolCount}
      </span>
      <span
        className={`conn-badge ${connected ? "conn-ok" : "conn-down"}`}
        data-testid="conn-badge"
      >
        {connected ? zhCN.status.connected : zhCN.status.disconnected}
      </span>
    </footer>
  );
}
