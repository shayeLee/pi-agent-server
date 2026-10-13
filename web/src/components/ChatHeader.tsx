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
          <InspectorToggle open={traceOpen} onToggle={onToggleTrace} />
        </div>
      </div>
    </header>
  );
}

export function InspectorToggle({ open, onToggle, testId = "trace-tab" }: { open: boolean; onToggle: () => void; testId?: string }) {
  const label = open ? "收起右侧栏" : "展开右侧栏";
  return <button type="button" className="btn-ghost btn-icon inspector-toggle" data-testid={testId}
    onClick={onToggle} aria-expanded={open} aria-controls="session-inspector" aria-label={label} title={label}>
    <Icon name="sidebar" size={16} />
  </button>;
}
