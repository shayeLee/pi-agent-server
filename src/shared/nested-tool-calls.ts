// 工具在运行中发起的嵌套调用（例如 codemode 脚本里的 MCP 调用）。
// 实时 SSE 与历史导出用同一形状，字段名沿用 SDK 记在工具结果消息上的 nestedCalls。

/** running 只出现在实时状态里；unfinished 表示父调用结束时它还没结束。 */
export type NestedToolCallStatus = "running" | "ok" | "error" | "unfinished";

export type NestedToolCall = {
  id: string;
  name: string;
  status: NestedToolCallStatus;
  /** 超过 SDK 记录上限时省略，此时 argumentsBytes 给出大小。 */
  arguments?: unknown;
  argumentsBytes?: number;
  durationMs?: number;
  /** 错误摘要，最多 500 字符。 */
  error?: string;
};

export type NestedToolCalls = {
  calls: NestedToolCall[];
  /** false：有调用被丢弃、参数被省略，或父调用结束时仍有调用未完成。 */
  complete: boolean;
};

/** 与 SDK 的 NESTED_CALL_LIMITS 一致。 */
export const NESTED_CALL_MAX = 256;
export const NESTED_ERROR_MAX_CHARS = 500;

const STATUSES: ReadonlySet<string> = new Set(["running", "ok", "error", "unfinished"]);

/** 校验并规范化一份嵌套调用记录；形状不对时返回 undefined。 */
export function readNestedToolCalls(value: unknown, mapArguments: (value: unknown) => unknown = v => v): NestedToolCalls | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { calls, complete } = value as { calls?: unknown; complete?: unknown };
  if (!Array.isArray(calls) || typeof complete !== "boolean") return undefined;
  const parsed: NestedToolCall[] = [];
  for (const raw of calls.slice(0, NESTED_CALL_MAX)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const call = raw as Record<string, unknown>;
    if (typeof call.id !== "string" || typeof call.name !== "string" || typeof call.status !== "string" || !STATUSES.has(call.status)) continue;
    parsed.push({
      id: call.id, name: call.name, status: call.status as NestedToolCallStatus,
      ...(call.arguments !== undefined ? { arguments: mapArguments(call.arguments) } : {}),
      ...(isCount(call.argumentsBytes) ? { argumentsBytes: call.argumentsBytes } : {}),
      ...(isCount(call.durationMs) ? { durationMs: call.durationMs } : {}),
      ...(typeof call.error === "string" ? { error: call.error.slice(0, NESTED_ERROR_MAX_CHARS) } : {}),
    });
  }
  return { calls: parsed, complete: complete && parsed.length === calls.length };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
