import type { DeepSeekV4TextToolEvent } from "./text-tool-parser.js";

const FRAME_START = "<｜｜DSML｜｜tool_calls>";
const FRAME_END = "</｜｜DSML｜｜tool_calls>";
const TOKEN = "｜｜DSML｜｜";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PARAMS = 32;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/** Parses the DSML text protocol observed from opencode/deepseek-v4-flash-free. */
export class DeepSeekV4DsmlTextToolParser {
  private buffer = "";
  private inFrame = false;

  push(delta: string): DeepSeekV4TextToolEvent[] {
    this.buffer += delta;
    const events: DeepSeekV4TextToolEvent[] = [];

    while (this.buffer.length > 0) {
      if (!this.inFrame) {
        const startAt = this.buffer.indexOf(FRAME_START);
        if (startAt === -1) {
          const suffixLength = longestPrefixSuffix(this.buffer, FRAME_START);
          const text = this.buffer.slice(0, this.buffer.length - suffixLength);
          if (text) events.push({ type: "text", text });
          this.buffer = this.buffer.slice(this.buffer.length - suffixLength);
          break;
        }
        const text = this.buffer.slice(0, startAt);
        if (text) events.push({ type: "text", text });
        this.buffer = this.buffer.slice(startAt);
        this.inFrame = true;
      }

      const endAt = this.buffer.indexOf(FRAME_END);
      if (endAt === -1) {
        if (this.buffer.length > MAX_FRAME_BYTES) {
          events.push({ type: "protocol_error", code: "tool_markup_too_large" });
          this.buffer = "";
          this.inFrame = false;
        }
        break;
      }

      const frame = this.buffer.slice(0, endAt + FRAME_END.length);
      this.buffer = this.buffer.slice(endAt + FRAME_END.length);
      this.inFrame = false;
      const toolCall = parseFrame(frame);
      if (toolCall) events.push(toolCall);
      else events.push({ type: "protocol_error", code: "malformed_tool_markup" });
    }

    return events;
  }

  finish(): DeepSeekV4TextToolEvent[] {
    if (!this.inFrame) {
      const text = this.buffer;
      this.buffer = "";
      return text ? [{ type: "text", text }] : [];
    }
    this.buffer = "";
    this.inFrame = false;
    return [{ type: "protocol_error", code: "incomplete_tool_markup" }];
  }
}

function parseFrame(frame: string): Extract<DeepSeekV4TextToolEvent, { type: "tool_call" }> | null {
  const body = frame.slice(FRAME_START.length, -FRAME_END.length);
  const opening = new RegExp(`^\\s*<${TOKEN}invoke\\s+name=(['"])([^'"<>\\s]+)\\1\\s*>`).exec(body);
  if (!opening || !NAME_PATTERN.test(opening[2] ?? "")) return null;

  const invokeBody = body.slice(opening[0].length).trimEnd();
  const close = `</${TOKEN}invoke>`;
  if (!invokeBody.endsWith(close)) return null;
  const parameterBody = invokeBody.slice(0, -close.length);
  const parameters: Record<string, string> = {};
  const parameterPattern = new RegExp(
    `\\s*<${TOKEN}parameter\\s+name=(['"])([^'"<>\\s]+)\\1(?:\\s+string=(['"])true\\3)?\\s*>([\\s\\S]*?)</${TOKEN}parameter>\\s*`,
    "gy",
  );
  let matchedLength = 0;
  let count = 0;
  while (true) {
    const match = parameterPattern.exec(parameterBody);
    if (!match) break;
    matchedLength = parameterPattern.lastIndex;
    const name = match[2] ?? "";
    if (!NAME_PATTERN.test(name) || name in parameters || ++count > MAX_PARAMS) return null;
    const value = decodeEntities(match[4] ?? "");
    if (value === null) return null;
    parameters[name] = value;
  }

  if (count === 0 || matchedLength !== parameterBody.length) return null;
  return { type: "tool_call", name: opening[2]!, arguments: parameters, raw: frame };
}

function longestPrefixSuffix(value: string, prefix: string): number {
  const max = Math.min(value.length, prefix.length - 1);
  for (let length = max; length > 0; length--) {
    if (value.endsWith(prefix.slice(0, length))) return length;
  }
  return 0;
}

function decodeEntities(value: string): string | null {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
