/** Compatibility facade: pure data only, never imports renderer modules. */
export { subagentTasks, isSubagentTask, type SubagentTask } from "./tools/subagent-data.js";
import { toolHeader } from "./tools/metadata.js";
import type { ToolCall } from "pi-agent-server/client";
export function toolSummary(call: ToolCall): string { return toolHeader(call).summary; }
