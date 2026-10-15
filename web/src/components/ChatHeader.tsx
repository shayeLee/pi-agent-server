import { zhCN } from "../i18n/zh-CN.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";
import { Icon } from "./Icon.js";
import { RunStatusBadge } from "./RunStatusBadge.js";
import type { RunStatus } from "../hooks/useRunStatus.js";

export type ChatHeaderProps = {
  session: SessionRecord;
  /** Project working directory shown above the title (DESIGN.md §3.1). */
  cwd?: string | null;
  traceOpen: boolean;
  onToggleTrace: () => void;
  runStatus?: RunStatus;
  /** First Esc pressed during a run; a second one within the window aborts. */
  abortArmed?: boolean;
};

export function ChatHeader({ session, cwd, traceOpen, onToggleTrace, runStatus, abortArmed }: ChatHeaderProps) {
  return (
    <header className="chat-header workbench-chat-header" data-testid="chat-header">
      <div className="workbench-topbar">
        <div className="chat-header-left">
          <div className="chat-header-titles">
            {cwd && <span className="chat-header-cwd" title={cwd}>{cwd}</span>}
            <span className="session-title-main" data-testid="chat-session-title" title={resolveSessionDisplayTitle(session)}>
              {resolveSessionDisplayTitle(session)}
            </span>
          </div>
          <div className="chat-header-actions">
            {runStatus && <RunStatusBadge status={runStatus} abortArmed={abortArmed} />}
            <InspectorToggle open={traceOpen} onToggle={onToggleTrace} />
          </div>
        </div>
      </div>
    </header>
  );
}

export function InspectorToggle({ open, onToggle, testId = "trace-tab" }: { open: boolean; onToggle: () => void; testId?: string }) {
  // A text disclosure, not a tab: the name stays constant, aria-expanded carries the state.
  return <button type="button" className="inspector-toggle" data-testid={testId}
    onClick={onToggle} aria-expanded={open} aria-controls="session-inspector" aria-label={zhCN.header.trace}
    title={open ? zhCN.header.closeTrace : zhCN.header.openTrace}>
    <Icon name="file" size={14} />{zhCN.header.trace}
  </button>;
}
