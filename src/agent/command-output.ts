// 扩展命令（/antigravity.usage 等）的输出：作为 custom 条目记在会话 JSONL 里（不进模型上下文），
// 页面实时收到 command_output 事件，导出历史时也会投影出来。
import type { CommandOutputLine, CommandOutputRecord } from "../shared/commands.js";
import type { CommandOutputEvent } from "../shared/events.js";

export const COMMAND_OUTPUT_ENTRY_TYPE = "pi-agent-server:command";

const LEVELS = new Set(["info", "warning", "error"]);

function isLine(value: unknown): value is CommandOutputLine {
  const line = value as Record<string, unknown> | null;
  return !!line && typeof line === "object" && typeof line.text === "string" && typeof line.level === "string" && LEVELS.has(line.level);
}

export function commandOutputFromEntry(value: unknown): CommandOutputEvent | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.type !== "custom" || entry.customType !== COMMAND_OUTPUT_ENTRY_TYPE ||
      typeof entry.id !== "string" || !entry.id || typeof entry.timestamp !== "string") return null;
  const data = entry.data as Partial<CommandOutputRecord> | null;
  if (!data || typeof data !== "object" || data.version !== 1 || typeof data.name !== "string" || !data.name ||
      typeof data.args !== "string" || typeof data.failed !== "boolean" || !Array.isArray(data.output) || !data.output.every(isLine)) return null;
  return { type: "command_output", version: 1, name: data.name, args: data.args, failed: data.failed,
    output: data.output.map(line => ({ level: line.level, text: line.text })), entryId: entry.id, timestamp: entry.timestamp };
}
