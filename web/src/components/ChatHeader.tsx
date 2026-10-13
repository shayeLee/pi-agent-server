import { zhCN } from "../i18n/zh-CN.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";
import { Icon } from "./Icon.js";

export type ChatHeaderProps = {
  session: SessionRecord;
  traceOpen: boolean;
  onToggleTrace: () => void;
};

export function ChatHeader({ session, traceOpen, onToggleTrace }: ChatHeaderProps) {
  return (
    <header className="chat-header workbench-chat-header" data-testid="chat-header">
      <div className="workbench-topbar">
        <div className="chat-header-left">
          <span className="session-title-main" data-testid="chat-session-title" title={resolveSessionDisplayTitle(session)}>
            {resolveSessionDisplayTitle(session)}
          </span>
          <button
            type="button"
            className="trace-toggle"
            data-testid="trace-tab"
            onClick={onToggleTrace}
            aria-expanded={traceOpen}
            aria-controls="session-inspector"
            title={traceOpen ? zhCN.trace.close : zhCN.trace.open}
          >
            <Icon name="file" size={15} />
            {zhCN.trace.title}</button>
        </div>
      </div>
    </header>
  );
}
