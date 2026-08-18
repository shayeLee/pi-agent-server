export type DeepSeekV4TextToolEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, string>; raw: string }
  | { type: "protocol_error"; code: "malformed_tool_markup" | "tool_markup_too_large" | "incomplete_tool_markup" };

const TOOL_PREFIX = "<use_tool";
const TOOL_END = "</use_tool>";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PARAMS = 32;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/**
 * Parses the textual tool markup emitted by DeepSeek V4 models before it can
 * escape as normal text. This parser only normalizes protocol; authorization
 * and execution remain in Pi's native tool-call path.
 */
export class DeepSeekV4TextToolParser {
  private buffer = "";
  private inToolFrame = false;

  push(delta: string): DeepSeekV4TextToolEvent[] {
    this.buffer += delta;
    const events: DeepSeekV4TextToolEvent[] = [];

    while (this.buffer.length > 0) {
      if (!this.inToolFrame) {
        const prefixAt = this.buffer.indexOf(TOOL_PREFIX);
        if (prefixAt === -1) {
          const suffixLength = longestPrefixSuffix(this.buffer, TOOL_PREFIX);
          const text = this.buffer.slice(0, this.buffer.length - suffixLength);
          if (text) events.push({ type: "text", text });
          this.buffer = this.buffer.slice(this.buffer.length - suffixLength);
          break;
        }

        const text = this.buffer.slice(0, prefixAt);
        if (text) events.push({ type: "text", text });
        this.buffer = this.buffer.slice(prefixAt);
        this.inToolFrame = true;
      }

      const endAt = this.buffer.indexOf(TOOL_END);
      if (endAt === -1) {
        if (this.buffer.length > MAX_FRAME_BYTES) {
          events.push({ type: "protocol_error", code: "tool_markup_too_large" });
          this.buffer = "";
          this.inToolFrame = false;
        }
        break;
      }

      const frame = this.buffer.slice(0, endAt + TOOL_END.length);
      this.buffer = this.buffer.slice(endAt + TOOL_END.length);
      this.inToolFrame = false;

      const toolCall = parseToolFrame(frame);
      if (toolCall) events.push(toolCall);
      else events.push({ type: "protocol_error", code: "malformed_tool_markup" });
    }

    return events;
  }

  finish(): DeepSeekV4TextToolEvent[] {
    if (!this.inToolFrame) {
      const text = this.buffer;
      this.buffer = "";
      return text ? [{ type: "text", text }] : [];
    }

    this.buffer = "";
    this.inToolFrame = false;
    return [{ type: "protocol_error", code: "incomplete_tool_markup" }];
  }
}

function parseToolFrame(frame: string): Extract<DeepSeekV4TextToolEvent, { type: "tool_call" }> | null {
  const opening = /^<use_tool\s+name=(['"])([^'"<>\s]+)\1\s*>/.exec(frame);
  if (!opening || !NAME_PATTERN.test(opening[2] ?? "")) return null;

  const body = frame.slice(opening[0].length, -TOOL_END.length);
  const argumentsObject: Record<string, string> = {};
  const paramPattern = /\s*<param\s+name=(['"])([^'"<>\s]+)\1\s*>([\s\S]*?)<\/param>\s*/gy;
  let params = 0;
  let matchedLength = 0;

  while (true) {
    const match = paramPattern.exec(body);
    if (!match) break;
    matchedLength = paramPattern.lastIndex;
    const name = match[2] ?? "";
    if (!NAME_PATTERN.test(name) || name in argumentsObject || ++params > MAX_PARAMS) return null;
    const value = decodeEntities(match[3] ?? "");
    if (value === null) return null;
    argumentsObject[name] = value;
  }

  if (matchedLength !== body.length || params === 0) return null;
  return { type: "tool_call", name: opening[2]!, arguments: argumentsObject, raw: frame };
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
