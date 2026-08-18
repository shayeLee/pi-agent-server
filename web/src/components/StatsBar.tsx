import type { TimelineItem, UsageStats } from "../types.js";

export type StatsBarProps = {
  stats: UsageStats | null;
  connected: boolean;
  timeline: TimelineItem[];
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StatsBar({ stats, connected, timeline }: StatsBarProps) {
  const messageCount = timeline.filter((i) => i.kind === "message").length;
  const toolCount = timeline.filter((i) => i.kind === "tool").length;
  const turnCount = Math.max(1, Math.floor(messageCount / 2));

  return (
    <div className="stats-bar" data-testid="stats-bar">
      <span className="stat-item" data-testid="stat-turns">
        {turnCount} turns
      </span>
      <span className="stat-separator" />
      <span className="stat-item" data-testid="stat-steps">
        {toolCount} steps
      </span>
      {stats && (
        <>
          <span className="stat-separator" />
          <span className="stat-item" data-testid="stat-duration">
            LLM {formatMs(stats.durationMs)}
          </span>
          <span className="stat-separator" />
          <span className="stat-item" data-testid="stat-ttft">
            TTFT {formatMs(stats.ttftMs)}
          </span>
          <span className="stat-separator" />
          <span className="stat-item" data-testid="stat-tokens">
            {stats.totalTokens.toLocaleString()} tok
          </span>
        </>
      )}
      <span className="stat-separator" />
      <span className={`stat-item ${connected ? "conn-ok" : "conn-down"}`} data-testid="stat-conn">
        {connected ? "已连接" : "未连接"}
      </span>
    </div>
  );
}
