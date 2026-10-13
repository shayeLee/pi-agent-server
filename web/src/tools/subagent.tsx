import { zhCN } from "../i18n/zh-CN.js";
import { GenericResult, ParameterFields, Parameters, type ParameterPolicy } from "./generic.js";
import { subagentTasks, isSubagentTask } from "./subagent-data.js";
import type { ArgumentsProps, ResultProps } from "./contract.js";

/** Known agent prose opts into Markdown; generic data fallback stays plain. */
export function SubagentResult(props: ResultProps) {
  return <GenericResult {...props} initialFormat="markdown" />;
}

const subagentPolicy: ParameterPolicy = { taskList: true, renderObject: value => isSubagentTask(value) ? <SubagentTaskFields value={value} /> : null };
export function SubagentTaskFields({ value }: { value: { agent: string; task: string } & Record<string, unknown> }) {
  const extra = Object.fromEntries(Object.entries(value).filter(([name]) => name !== "agent" && name !== "task"));
  return <div className="tool-subagent-task">
    <strong className="tool-subagent-agent">{value.agent}</strong>
    <pre className="tool-readable-value">{value.task}</pre>
    {Object.keys(extra).length > 0 && <ParameterFields value={extra} policy={subagentPolicy} />}
  </div>;
}

export function SubagentArguments({ value }: ArgumentsProps) {
  const tasks = subagentTasks("subagent", value);
  if (!tasks) return <Parameters value={value} policy={subagentPolicy} />;
  return <section className="json-block" aria-label={zhCN.toolParameters.label}><div className="tool-subagent-parameters">
    {Object.entries(value as object).map(([name, field]) => name === "tasks"
      ? <ol key={name} className="tool-parallel-tasks" aria-label={zhCN.toolParameters.agentTasks}>{tasks.map((task, index) => <li key={index}><SubagentTaskFields value={task} /></li>)}</ol>
      : <ParameterFields key={name} value={{ [name]: field }} policy={subagentPolicy} />)}
  </div></section>;
}
