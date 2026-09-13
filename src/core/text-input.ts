// 面向「一轮对话文本输入」的中立长度/字符校验（公开 messages 接口与插件 runTurn 共用）。
// 只做与传输/存储无关的纯字符串规则，不依赖 Fastify、数据库或 Pi SDK。
//
// 为什么需要独立模块：`POST /v1/sessions/:id/messages`（公开 HTTP）与宿主插件
// `PluginSessionApi.runTurn`（进程内调用）必须执行**同一套** requestId/prompt 限制，
// 否则两条入口会出现「插件被拒但 HTTP 放行（或反之）」的不一致契约。
// `src/plugin/contract.ts` 的 `PLUGIN_RUN_TURN_LIMITS` 是对外公开常量，
// 这里保持内部权威值，并在测试中断言两者相等（防止漂移）。

/** 一轮文本输入的长度上限（UTF-16 code units）。 */
export const TURN_TEXT_LIMITS = {
  /** requestId 最大长度。 */
  maxRequestIdLength: 128,
  /** prompt 最大长度。 */
  maxPromptLength: 32_768,
} as const;

/**
 * 非法控制字符：C0 中除 \t(\u0009)、\n(\u000a)、\r(\u000d) 之外的全部，以及 DEL(\u007f)。
 * 这些字符在 JSON 中合法但会污染日志/终端/文件名，且没有正当业务语义。
 */
const ILLEGAL_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type TurnTextFailure = "empty" | "too-long" | "control-characters";

export type TurnTextResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: TurnTextFailure };

/**
 * 校验一轮文本输入：默认必须是非空（去空白后）字符串；仅公开消息携带已验证图片时可显式
 * `allowEmpty`。无论是否允许空文本，都不得含非法控制字符且长度不得超过 maxLength。
 * 返回值只含固定原因枚举，绝不回显调用方传入的内容（调用方据此生成脱敏错误）。
 */
export function checkTurnText(
  value: unknown,
  maxLength: number,
  options: { allowEmpty?: boolean } = {},
): TurnTextResult {
  if (typeof value !== "string") return { ok: false, reason: "empty" };
  if (!options.allowEmpty && value.trim() === "") return { ok: false, reason: "empty" };
  if (value.length > maxLength) return { ok: false, reason: "too-long" };
  if (ILLEGAL_CONTROL_CHARACTERS.test(value)) return { ok: false, reason: "control-characters" };
  return { ok: true, value };
}
