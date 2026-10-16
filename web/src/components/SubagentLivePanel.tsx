import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useState } from "react";
import type { LiveSubagent } from "../hooks/useLiveSubagents.js";
import { formatElapsed } from "../hooks/useRunStatus.js";

/**
 * Running child agents of this session (DESIGN.md §4.7). Runs carry no tool-call link,
 * so the panel is session-level and never guesses which step started which run.
 */
export function SubagentLivePanel({ items, onOpen }: { items: LiveSubagent[]; onOpen?: (runId: string) => void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!items.length) return;
    const timer = setInterval(() => setTick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [items.length]);
  if (!items.length) return null;
  return <section className="subagent-live" aria-label={zhCN.subagentLive.label} data-testid="subagent-live">
    {items.map(({ run, actions, reply }) => <div key={run.id} className="subagent-live-run">
      <div className="subagent-live-head">
        <span className="subagent-live-glyph" aria-hidden="true">◐</span>
        <span className="subagent-live-name">{run.agent} #{run.runId}</span>
        <span className="subagent-live-task" title={run.task}>{run.task}</span>
        <span className="subagent-live-time">{formatElapsed(Date.now() - run.startedAt)}</span>
      </div>
      <div className="subagent-live-bar" aria-hidden="true"><i /></div>
      {actions.length > 0 && <ol className="subagent-live-actions">
        {actions.map((action, index) => <li key={action.id} className={!action.done && index === actions.length - 1 ? "is-live" : undefined}>
          <span className="subagent-live-tool">{action.toolName}</span>
          <span className="subagent-live-summary">{action.summary}{!action.done && index === actions.length - 1 && <span className="ledger-caret" aria-hidden="true" />}</span>
        </li>)}
      </ol>}
      {reply && <p className={`subagent-live-reply${reply.streaming ? " is-live" : ""}`} data-testid="subagent-live-reply" title={reply.text}>
        <span className="subagent-live-reply-text">{reply.text}</span>
        {reply.streaming && <span className="ledger-caret" aria-hidden="true" />}
      </p>}
      {onOpen && <button type="button" className="subagent-live-open" onClick={() => onOpen(run.id)}>{zhCN.subagentLive.open}</button>}
    </div>)}
  </section>;
}
