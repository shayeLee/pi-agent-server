import type { ToolCall } from "pi-agent-server/client";

/** 把 unknown 值转成可读文本：字符串原样展示，其它 JSON 美化序列化。 */
export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** JSON transport values are preserved; missing root values omit their key (never become null). */
export function rawToolData(call: ToolCall): string {
  return JSON.stringify({
    argsProvided: call.args !== undefined,
    ...(call.args !== undefined ? { args: call.args } : {}),
    resultKind: call.done ? "final" : "partial",
    resultProvided: (call.done ? call.result : call.partialResult) !== undefined,
    ...((call.done ? call.result : call.partialResult) !== undefined
      ? { [call.done ? "result" : "partialResult"]: call.done ? call.result : call.partialResult } : {}),
  }, null, 2);
}
