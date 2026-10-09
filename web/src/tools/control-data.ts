import { record, line } from "./summary-data.js";
import type { ToolMetadata } from "./contract.js";

export const controlMetadata: ToolMetadata = {
 icon: "agents",
 summarize(call) {
 const args = record(call.args);
 let preview = "";
 switch (call.toolName) {
    case "subagent_wait":
      preview = Array.isArray(args.runIds) && args.runIds.length ? `runIds=${JSON.stringify(args.runIds)}${args.timeoutMs !== undefined ? ` timeoutMs=${line(args.timeoutMs)}` : ""}` : "全部待收集 runs";
      break;
    case "subagent_status": preview = args.runId !== undefined ? `run: ${line(args.runId)}` : "全部 runs"; break;
    case "subagent_logs": preview = `run: ${line(args.runId)} · tail: ${args.tail !== undefined ? line(args.tail) : "全部"}`; break;
    case "subagent_steer": preview = `run: ${line(args.runId)} · message: ${line(args.message)}`; break;
    case "subagent_stop": preview = `run: ${line(args.runId)}`; break;
 }
 return { summary: preview };
 },
};
