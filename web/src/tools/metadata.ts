import { zhCN } from "../i18n/zh-CN.js";
import type { ToolCall } from "pi-agent-server/client";
import type { ToolHeader, ToolMetadata } from "./contract.js";
import { record, line, lines, resultText } from "./summary-data.js";
import { subagentMetadata } from "./subagent-data.js";
import { isFileAcknowledgement } from "./file-data.js";
import { controlMetadata } from "./control-data.js";

const generic: ToolMetadata = {
  icon: "tool",
  summarize(call) {
    const args = record(call.args);
    return { summary: Object.keys(args).length ? Object.entries(args).slice(0, 4).map(([key, value]) => `${key}: ${line(value)}`).join(" · ") : call.args !== null && typeof call.args === "object" && Object.keys(call.args).length === 0 ? "" : line(call.args) };
  },
};
const file: ToolMetadata = {
  icon: "file",
  summarize(call) {
    const args = record(call.args);
    return { summary: line(args.path) + (Array.isArray(args.edits) ? zhCN.toolParameters.editCount(args.edits.length) : "") };
  },
};
/** Explicit registrations; unknown tools need no adapter to remain readable. */
const registry: Readonly<Record<string, ToolMetadata>> = {
  subagent: subagentMetadata,
  subagent_wait: { ...controlMetadata, icon: "clock", outputLines: 5 },
  subagent_status: controlMetadata, subagent_logs: controlMetadata,
  subagent_steer: controlMetadata, subagent_stop: controlMetadata,
  bash: { icon: "terminal", outputLines: "last", summarize: call => ({ summary: line(record(call.args).command) }) },
  read: file, write: file, edit: { ...file, icon: "edit" },
  wait: { ...generic, icon: "clock" },
  find: { ...generic, icon: "search" }, grep: { ...generic, icon: "search" },
  ls: { ...generic, icon: "folder" },
};
export function resolveToolMetadata(name: string): ToolMetadata {
  return Object.hasOwn(registry, name) ? registry[name] : name.startsWith("subagent_") ? { ...generic, icon: "agents" } : generic;
}
export function toolIcon(name: string): ToolHeader["icon"] { return resolveToolMetadata(name).icon; }
export function toolHeader(call: ToolCall): ToolHeader {
  const adapter = resolveToolMetadata(call.toolName);
  const header = adapter.summarize(call);
  const output = isFileAcknowledgement(call) ? [] : lines(resultText(call.result !== undefined ? call.result : call.done ? undefined : call.partialResult));
  const count = adapter.outputLines ?? 1;
  const latest = count === "last" ? output.slice(-1) : output.slice(0, count);
  const suffix = [...latest.map(line), ...(typeof count === "number" && count > 1 && output.length > count ? ["…"] : [])];
  return { ...header, icon: adapter.icon, summary: [header.summary, ...suffix].filter(Boolean).join(" · "),
    ...(header.priorityLabels ? { preview: [header.preview, ...suffix].filter(Boolean).join(" · ") } : {}) };
}
