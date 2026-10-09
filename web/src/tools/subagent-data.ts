import { record, line } from "./summary-data.js";
import type { ToolMetadata } from "./contract.js";

export type SubagentTask = { agent: string; task: string } & Record<string, unknown>;
export function isSubagentTask(value: unknown): value is SubagentTask {
  const item = record(value);
  return typeof item.agent === "string" && item.agent.trim().length > 0 && typeof item.task === "string";
}

/** Recognize only the explicit task-array schema, never result text or run IDs. */
export function subagentTasks(toolName: string, args: unknown): SubagentTask[] | undefined {
  const tasks = record(args).tasks;
  return toolName === "subagent" && Array.isArray(tasks) && tasks.length > 0 && tasks.every(isSubagentTask) ? tasks : undefined;
}

export const subagentMetadata: ToolMetadata = {
  icon: "agents",
  summarize(call) {
    const tasks = subagentTasks(call.toolName, call.args);
    const args = record(call.args);
    if (tasks && tasks.length > 1) {
      const priorityLabels = tasks.map(item => item.agent);
      const preview = tasks.map(item => line(item.task)).join(" · ");
      return { summary: `${priorityLabels.join("、")} · ${preview}`, badge: `并行 ${tasks.length}`, priorityLabels, preview };
    }
    return { summary: tasks ? `${tasks[0].agent}: ${line(tasks[0].task)}`
      : isSubagentTask(args) && !("tasks" in args) ? `${args.agent}: ${line(args.task)}` : line(call.args) };
  },
};
