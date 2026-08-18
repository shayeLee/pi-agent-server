import type { ChatPhase } from "../lib/chat-state.js";

const PHASE_LABEL: Record<ChatPhase, string> = {
  idle: "空闲",
  queued: "排队中",
  streaming: "流式输出",
  completed: "已完成",
  aborted: "已中止",
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
        消息 {messageCount} · 工具 {toolCount}
      </span>
      <span
        className={`conn-badge ${connected ? "conn-ok" : "conn-down"}`}
        data-testid="conn-badge"
      >
        {connected ? "已连接" : "未连接"}
      </span>
    </footer>
  );
}
