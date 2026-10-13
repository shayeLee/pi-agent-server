import type { SubagentConversation, SubagentRun } from "pi-agent-server/client";
import { ToolStatusIcon } from "./ToolStatusIcon.js";
import { Icon } from "./Icon.js";
import { Timeline } from "./Timeline.js";
import { InspectorToggle } from "./ChatHeader.js";
import { useFollowBottom } from "../hooks/useFollowBottom.js";

const labels = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止", unknown: "状态未知" };
function SubagentStatusIcon({ status }: { status: SubagentRun["status"] }) {
  return <span className="subagent-status-icon" role="img" aria-label={labels[status]} title={labels[status]}>
    <span aria-hidden="true">{status === "unknown"
      ? <Icon name="hourglass" size={14} />
      : <ToolStatusIcon done={status !== "running"} isError={status === "failed" || status === "stopped"} />}</span>
  </span>;
}

function duration(run: SubagentRun) {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? (run.status === "running" ? Date.now() : run.startedAt)) - run.startedAt) / 1000));
  if (run.status === "unknown" && !run.endedAt) return "历史记录";
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
export function SubagentList({ runs, selected, onSelect, loading, error }: {
  runs: SubagentRun[]; selected: string | null; onSelect: (id: string) => void; loading: boolean; error: string | null;
}) {
  return <div className="subagent-list" data-testid="subagent-list">
    <div className="subagent-list-summary">当前会话 · {runs.length} 个任务 · {runs.filter(r => r.status === "running").length} 个运行中</div>
    {error && <div role="alert" className="subagent-notice">{error}</div>}
    {loading && !runs.length && <p role="status">正在读取子代理记录…</p>}
    {!loading && !error && !runs.length && <p className="subagent-notice">暂无子代理记录。旧版扩展未保存的过程无法恢复。</p>}
    {runs.map(run => <button type="button" key={run.id} className={`subagent-list-row${selected === run.id ? " selected" : ""}`}
      aria-pressed={selected === run.id} onClick={() => onSelect(run.id)}>
      <span className="subagent-list-heading"><strong>{run.agent} #{run.runId}</strong><span className="subagent-list-time subagent-duration-status"><SubagentStatusIcon status={run.status} /><span>{duration(run)}</span></span></span>
      <span className="subagent-list-task">{run.task}</span>
    </button>)}
  </div>;
}

export function SubagentChat({ conversation, loading, error, title, inspectorOpen, onBack, onToggleInspector }: {
  conversation: SubagentConversation | null; loading: boolean; error: string | null; title: string; inspectorOpen: boolean;
  onBack: () => void; onToggleInspector: () => void;
}) {
  const scroll = useFollowBottom(conversation?.run.id ?? "loading", conversation);
  const run = conversation?.run;
  return <section className="chat subagent-chat" data-testid="subagent-chat">
    <header className="chat-header workbench-chat-header" data-testid="child-chat-header">
      <div className="subagent-topbar"><button type="button" className="subagent-back" onClick={onBack}>← 返回主会话</button>
        <span className="subagent-breadcrumb" title={title}>{title}{run && ` / ${run.agent} #${run.runId}`}</span>
        <InspectorToggle open={inspectorOpen} onToggle={onToggleInspector} testId="child-subagents-toggle" />
      </div>
    </header>
    {run && <div className="subagent-meta"><strong>{run.agent} #{run.runId}</strong><span className="subagent-meta-task" title={run.task}>{run.task}</span><span className="subagent-meta-details">{(run.model || run.thinkingLevel) && <span>{[run.model, run.thinkingLevel].filter(Boolean).join(" ")}</span>}<span className="subagent-duration-status"><SubagentStatusIcon status={run.status} /><span>{duration(run)}</span></span></span></div>}
    <div className="chat-body" ref={scroll.ref} onScroll={scroll.onScroll}>
      <div className="chat-inner">
        {error && <div role="alert" className="subagent-notice">{error}</div>}
        {loading && !conversation && <p role="status">正在读取会话…</p>}
        {!loading && !error && !conversation && <p>该子代理记录不可用，请返回列表重新选择。</p>}
        {conversation && <>
          {run?.status === "unknown" && <p className="subagent-notice">没有可确认的运行状态，以下为已保存记录。</p>}
          <Timeline timeline={conversation.timeline} />
          {conversation.inputs.filter(i => i.delivery !== "delivered").map(input => <div key={input.id} className="subagent-pending-input">
            <div className="subagent-message-source">主代理 · {input.kind === "initial" ? "初始任务" : "steer"} · {input.delivery === "failed" ? "发送失败" : input.delivery === "unknown" ? "送达未确认" : "已提交，等待送达"}</div>
            <div>{input.text}</div>
          </div>)}
        </>}
      </div>
    </div>
  </section>;
}
