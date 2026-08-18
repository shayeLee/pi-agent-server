import type { SessionRecord } from "../types.js";

export type ChatHeaderProps = {
  session: SessionRecord;
  connected: boolean;
  onToggleDetails: () => void;
};

export function ChatHeader({
  session,
  connected,
  onToggleDetails,
}: ChatHeaderProps) {
  return (
    <header className="chat-header" data-testid="chat-header">
      <div className="chat-header-left">
        <span className="session-title-main" data-testid="chat-session-title">
          {session.title || "未命名会话"}
        </span>
        <span className="mode-badge" data-testid="connection-badge">
          <span style={{ color: connected ? "var(--ds-green)" : "var(--ds-red)" }}>●</span>
          {connected ? "已连接" : "未连接"}
        </span>
      </div>
      <div className="chat-tabs">
        <button className="active" data-testid="chat-tab">
          Chat
        </button>
      </div>
      <div className="header-actions">
        <button
          className="btn-secondary"
          data-testid="toggle-events"
          onClick={onToggleDetails}
          title="Session log"
        >
          Session log
        </button>
      </div>
    </header>
  );
}
