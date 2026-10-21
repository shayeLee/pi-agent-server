import { useState, type KeyboardEvent } from "react";
import type { SubagentConversation, SubagentRun } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { Timeline } from "./Timeline.js";
import { formatClock } from "./ledger.js";
import { formatSpan } from "../i18n/format.js";
import { InspectorToggle } from "./ChatHeader.js";
import { useFollowBottom } from "../hooks/useFollowBottom.js";
import { errorMessage } from "./ProjectMcpPanel.js";

/** The Ledger's step glyphs (DESIGN.md §5.1), so subagents read like the steps that started them. */
const glyphs = { running: "◐", completed: "✓", failed: "✗", stopped: "⊘", unknown: "·" };
function SubagentStatusIcon({ status }: { status: SubagentRun["status"] }) {
  const label = zhCN.subagents.status[status];
  return <span className={`subagent-glyph is-${status}`} role="img" aria-label={label} title={label}>
    <span aria-hidden="true">{glyphs[status]}</span>
  </span>;
}

/** Compact, monospace and right-aligned (10s, 2m16s), like step durations; null when nothing honest to show. */
function duration(run: SubagentRun): string | null {
  if (run.status === "unknown" && !run.endedAt) return null;
  return formatSpan(Math.max(0, (run.endedAt ?? (run.status === "running" ? Date.now() : run.startedAt)) - run.startedAt));
}
export function SubagentList({ runs, selected, onSelect, loading, error }: {
  runs: SubagentRun[]; selected: string | null; onSelect: (id: string) => void; loading: boolean; error: string | null;
}) {
  return <div className="subagent-list" data-testid="subagent-list">
    <div className="subagent-list-summary">{zhCN.subagents.summary(runs.length, runs.filter(r => r.status === "running").length)}</div>
    {error && <div role="alert" className="subagent-notice">{error}</div>}
    {loading && !runs.length && <p role="status">{zhCN.subagents.loadingList}</p>}
    {!loading && !error && !runs.length && <p className="subagent-notice">{zhCN.subagents.emptyList}</p>}
    {runs.map(run => <button type="button" key={run.id} className={`subagent-list-row${selected === run.id ? " selected" : ""}`}
      aria-pressed={selected === run.id} onClick={() => onSelect(run.id)}>
      <span className="subagent-list-heading"><SubagentStatusIcon status={run.status} /><strong>{run.agent} #{run.runId}</strong><span className="subagent-duration">{duration(run)}</span></span>
      <span className="subagent-list-task">{run.task}</span>
    </button>)}
  </div>;
}

/**
 * Steer only: the text reaches the running child at its next turn boundary, like the parent
 * agent's subagent_steer. A sent steer then shows in the conversation with its delivery state.
 */
function SubagentSteer({ run, canWrite, onSteer }: { run: SubagentRun; canWrite: boolean; onSteer: (runId: string, text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steerable = run.status === "running" && !run.legacy;
  const canSend = canWrite && steerable && !sending && text.trim() !== "";
  const send = async () => {
    if (!canSend) return;
    setSending(true); setError(null);
    try { await onSteer(run.id, text); setText(""); }
    catch (cause) { setError(errorMessage(cause) || zhCN.subagents.steer.failed); }
    finally { setSending(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault(); void send();
  };
  const placeholder = run.legacy ? zhCN.subagents.steer.legacy : steerable ? zhCN.subagents.steer.placeholder : zhCN.subagents.steer.ended;
  return <div className="chat-footer subagent-steer">
    <div className="composer-stack"><div className="composer" data-testid="subagent-steer">
      {error && <div className="composer-submit-notice" role="alert">{error}</div>}
      <textarea data-testid="subagent-steer-input" rows={1} aria-label={zhCN.subagents.steer.label} placeholder={placeholder}
        value={text} onChange={event => setText(event.target.value)} onKeyDown={onKeyDown}
        disabled={!canWrite || !steerable || sending} />
      <div className="composer-toolbar">
        <div className="composer-left" />
        <div className="composer-right">
          {steerable && <span className="composer-hint" aria-hidden="true">{zhCN.subagents.steer.hint}</span>}
          <button type="button" className="send-button" data-testid="subagent-steer-send" onClick={() => void send()}
            disabled={!canSend} aria-label={zhCN.subagents.steer.label}>
            <span className="send-button-visual">{sending ? zhCN.subagents.steer.sending : zhCN.subagents.steer.send}</span>
          </button>
        </div>
      </div>
    </div></div>
  </div>;
}

export function SubagentChat({ conversation, loading, error, title, inspectorOpen, onBack, onToggleInspector, canWrite = false, onSteer }: {
  conversation: SubagentConversation | null; loading: boolean; error: string | null; title: string; inspectorOpen: boolean;
  onBack: () => void; onToggleInspector: () => void;
  /** The viewer may control this session; without it the steer box stays disabled. */
  canWrite?: boolean;
  onSteer?: (runId: string, text: string) => Promise<void>;
}) {
  const scroll = useFollowBottom(conversation?.run.id ?? "loading", conversation);
  const run = conversation?.run;
  return <section className="chat subagent-chat" data-testid="subagent-chat">
    <header className="chat-header workbench-chat-header" data-testid="child-chat-header">
      <div className="subagent-topbar"><button type="button" className="subagent-back" onClick={onBack}>{zhCN.subagents.back}</button>
        <span className="subagent-breadcrumb" title={title}>{title}{run && ` / ${run.agent} #${run.runId}`}</span>
        <InspectorToggle open={inspectorOpen} onToggle={onToggleInspector} testId="child-subagents-toggle" />
      </div>
    </header>
    {/* The task is the first turn of the conversation below; the strip only says who, how and how long. */}
    {run && <div className="subagent-meta"><SubagentStatusIcon status={run.status} /><strong>{run.agent} #{run.runId}</strong><span className="subagent-meta-details">{(run.model || run.thinkingLevel) && <span>{[run.model, run.thinkingLevel].filter(Boolean).join(" ")}</span>}<span className="subagent-duration">{duration(run)}</span></span></div>}
    <div className="chat-body" ref={scroll.ref} onScroll={scroll.onScroll}>
      <div className="chat-inner">
        {error && <div role="alert" className="subagent-notice">{error}</div>}
        {loading && !conversation && <p role="status">{zhCN.subagents.loadingConversation}</p>}
        {!loading && !error && !conversation && <p>{zhCN.subagents.unavailable}</p>}
        {conversation && <>
          {run?.status === "unknown" && <p className="subagent-notice">{zhCN.subagents.unknownStatus}</p>}
          <Timeline timeline={conversation.timeline} />
          {/* Inputs not yet in the transcript: the same ledger row, with the delivery state in the gutter. */}
          {conversation.inputs.some(i => i.delivery !== "delivered") && <div className="ledger subagent-pending-inputs">
            {conversation.inputs.filter(i => i.delivery !== "delivered").map(input => {
              const kind = zhCN.subagents.inputKind[input.kind];
              const [tag, label] = input.source === "user" ? [zhCN.ledger.you, zhCN.ledger.youInputLabel(kind)] : [zhCN.ledger.host, zhCN.ledger.hostLabel(kind)];
              const clock = input.timestamp > 0 ? formatClock(new Date(input.timestamp).toISOString()) : null;
              return <div key={input.id} className="ledger-entry subagent-pending-input" data-role="user">
                <div className="ledger-time">{clock && <time dateTime={new Date(input.timestamp).toISOString()} title={clock.title}>{clock.text}</time>}
                  <span className="ledger-note">{kind}</span>
                  <span className="ledger-note">{zhCN.subagents.delivery[input.delivery === "delivered" ? "submitted" : input.delivery]}</span></div>
                <div className="ledger-tag" aria-label={label}>{tag}</div>
                <div className="ledger-body"><div className="message-user"><div className="user-bubble"><div>{input.text}</div></div></div></div>
              </div>;
            })}
          </div>}
        </>}
      </div>
    </div>
    {run && onSteer && <SubagentSteer key={run.id} run={run} canWrite={canWrite} onSteer={onSteer} />}
  </section>;
}
