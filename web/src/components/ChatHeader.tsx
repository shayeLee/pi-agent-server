import { Icon } from "./Icon.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";

export type ChatHeaderProps = {
  session: SessionRecord;
  traceActive: boolean;
  onToggleDetails: () => void;
  onSelectTab: (tab: "chat" | "trace") => void;
};

export function ChatHeader({
  session,
  traceActive,
  onToggleDetails,
  onSelectTab,
}: ChatHeaderProps) {
  return (
    <header className="chat-header workbench-chat-header" data-testid="chat-header">
      <div className="workbench-topbar">
        <div className="chat-header-left">
          <span className="session-title-main" data-testid="chat-session-title" title={resolveSessionDisplayTitle(session)}>
            {resolveSessionDisplayTitle(session)}
          </span>
          <nav className="chat-tabs" aria-label="会话视图">
            <button
              className={!traceActive ? "active" : ""}
              data-testid="chat-tab"
              onClick={() => onSelectTab("chat")}
              aria-current={!traceActive ? "page" : undefined}
            >
              对话
            </button>
            <button
              className={traceActive ? "active" : ""}
              data-testid="trace-tab"
              onClick={() => onSelectTab("trace")}
              aria-current={traceActive ? "page" : undefined}
            >
              轨迹
            </button>
          </nav>
        </div>
        <div className="header-actions">
          <button
            className="btn-ghost btn-icon"
            data-testid="toggle-events"
            onClick={onToggleDetails}
            title={traceActive ? "隐藏轨迹面板" : "显示轨迹面板"}
            aria-label={traceActive ? "隐藏轨迹面板" : "显示轨迹面板"}
            aria-expanded={traceActive}
          >
            <Icon name="inspector" />
          </button>
        </div>
      </div>
    </header>
  );
}
