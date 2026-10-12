import type { ToolCall } from "pi-agent-server/client";
import { record } from "./summary-data.js";

/** Only exact, single-line file receipts are presentation noise; unknown data stays visible. */
export function isFileAcknowledgement(call: ToolCall): boolean {
  if (!call.done || call.isError || !["edit", "write"].includes(call.toolName)) return false;
  const args = record(call.args);
  if (typeof args.path !== "string" || /[\r\n]/.test(args.path)) return false;
  let text: unknown = call.result;
  if (typeof text !== "string") {
    const result = record(text);
    if (Object.keys(result).some(key => key !== "content" && key !== "details")) return false;
    const content = result.content;
    if (!Array.isArray(content) || content.length !== 1) return false;
    const block = record(content[0]);
    if (block.type !== "text" || Object.keys(block).some(key => key !== "type" && key !== "text")) return false;
    // SDK edit diff/patch metadata stays in the result; the argument diff stays visible.
    // Only the known SDK shape is receipt noise; unknown metadata must keep the result visible.
    if (result.details !== undefined) {
      const details = record(result.details);
      if (call.toolName !== "edit" || Object.keys(details).length === 0
        || Object.keys(details).some(key => key !== "diff" && key !== "patch" && key !== "firstChangedLine")
        || typeof details.diff !== "string"
        || (details.patch !== undefined && typeof details.patch !== "string")
        || (details.firstChangedLine !== undefined && typeof details.firstChangedLine !== "number")) return false;
    }
    text = block.text;
  }
  if (typeof text !== "string" || /[\r\n]/.test(text)) return false;
  if (call.toolName === "write") return text === `Successfully wrote to ${args.path}`
    || new RegExp("^Successfully wrote [0-9]+ bytes to " + escapeRegex(args.path) + "$", "u").test(text);
  return text === `Successfully replaced text in ${args.path}.`
    || new RegExp("^Successfully replaced [1-9][0-9]* block\\(s\\) in " + escapeRegex(args.path) + "\\.$", "u").test(text);
}
function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
