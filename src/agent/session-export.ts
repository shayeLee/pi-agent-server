import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createExportImageProjectionState,
  projectExportImagesForMessage,
  type NormalizedImage,
} from "./image-input.js";

/** Legacy v1 message projection, retained unchanged for existing consumers. */
export type ExportMessage = {
  /** Stable Pi JSONL message-entry id when this is a persisted Pi transcript. */
  sourceId?: string;
  role: string;
  text: string;
  images?: readonly NormalizedImage[];
};

export type ExportTimelineItem =
  | { id: string; type: "message"; role: "user" | "assistant"; messageId: string; turnId: string | null; text: string; order: number; timestamp?: string }
  | { id: string; type: "tool_call"; messageId: string; turnId: string | null; callId: string; toolCallId: string; toolName: string; args: unknown; status: "completed" | "error" | "no_result"; order: number; timestamp?: string }
  | { id: string; type: "tool_result"; messageId: string | null; turnId: string | null; callId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean; order: number; timestamp?: string }
  | { id: string; type: "system_event"; event: "model_failback"; from: string; to: string; reason: string; order: number; timestamp?: string };

/** Additive export payload. `messages` is the pre-existing text/image projection. */
export type ExportSnapshot = { messages: ExportMessage[]; timeline: ExportTimelineItem[] };

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type ContentBlock = Record<string, unknown>;

export function projectExportMessages(messages: readonly unknown[], branch: readonly SessionEntry[] = [], hiddenMessageIds: ReadonlySet<string> = new Set()): ExportMessage[] {
  const state = createExportImageProjectionState();
  // A selected JSONL branch is the sole authoritative source for sourceId.  Do not
  // correlate the SDK context with text: image-only and prototype messages have no text.
  const source = branch.length > 0
    ? branch.filter((entry): entry is MessageEntry => {
      if (entry.type !== "message") return false;
      const role = (entry.message as { role?: unknown }).role;
      return role === "user" || role === "assistant";
    }).map((entry) => ({ message: entry.message as { role?: string; content?: unknown }, sourceId: entry.id }))
    : (messages as Array<{ role?: string; content?: unknown }>).filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ message }));
  return source.filter((row) => !("sourceId" in row && typeof row.sourceId === "string" && hiddenMessageIds.has(row.sourceId)) &&
    !(row.message.role === "assistant" && !hasVisibleAssistantContent(row.message.content))).map((row) => {
    const { message } = row;
    const sourceId = "sourceId" in row && typeof row.sourceId === "string" ? row.sourceId : undefined;
    // Do not repurpose an existing legacy id: sourceId is additive and has the JSONL meaning.
    const id = typeof (message as { id?: unknown }).id === "string" ? (message as { id: string }).id : undefined;
    const text = extractText(message.content);
    const identity = { ...(id ? { id } : {}), ...(sourceId ? { sourceId } : {}) };
    if (message.role !== "user") return { ...identity, role: "assistant", text };
    const images = projectExportImagesForMessage(message.content, state);
    return images.length > 0 ? { ...identity, role: "user", text, images } : { ...identity, role: "user", text };
  });
}

/**
 * Projects only the selected JSONL branch. Content order is preserved at block granularity:
 * assistant text and tool calls are never moved behind a final assistant message. Thinking is
 * deliberately excluded. Tool results are complete persisted values except credential fields and
 * binary image payloads, which follow the host's existing fail-closed image policy.
 */
export function projectExportSnapshot(messages: readonly unknown[], branch: readonly SessionEntry[]): ExportSnapshot {
  const presentation = failbackPresentation(branch);
  const legacy = projectExportMessages(messages, branch, presentation.hiddenContinuationIds);
  const calls = new Map<string, { messageId: string; turnId: string | null }>();
  const outcomes = new Map<string, boolean>();
  let turnId: string | null = null;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };
    if (message.role === "user") turnId = entry.id;
    if (message.role === "assistant") {
      forEachToolCall(message.content, (block) => {
        if (typeof block.id === "string") calls.set(block.id, { messageId: entry.id, turnId });
      });
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string" && typeof message.isError === "boolean") {
      outcomes.set(message.toolCallId, message.isError);
    }
  }

  const timeline: ExportTimelineItem[] = [];
  turnId = null;
  let order = 0;
  for (const entry of branch) {
    const failback = presentation.events.get(entry.id);
    if (failback) {
      timeline.push({ id: `system-event:${entry.id}`, type: "system_event", event: "model_failback", from: failback.from, to: failback.to, reason: failback.reason, order: order++, ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}) });
      continue;
    }
    if (entry.type !== "message" || presentation.hiddenContinuationIds.has(entry.id)) continue;
    const message = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (message.role === "user") {
      turnId = entry.id;
      timeline.push({ id: `message:${entry.id}`, type: "message", role: "user", messageId: entry.id, turnId, text: extractText(message.content), order: order++, ...(timestamp ? { timestamp } : {}) });
      continue;
    }
    if (message.role === "assistant") {
      if (!hasVisibleAssistantContent(message.content)) continue;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const messageOrder = order;
      let emittedMessageOrTool = false;
      for (let index = 0; index < blocks.length; index++) {
        const block = asRecord(blocks[index]);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          timeline.push({ id: `assistant-text:${entry.id}:${index}`, type: "message", role: "assistant", messageId: entry.id, turnId, text: block.text, order: order++, ...(timestamp ? { timestamp } : {}) });
          emittedMessageOrTool = true;
        } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          const outcome = outcomes.get(block.id);
          timeline.push({
            id: `tool-call:${entry.id}:${index}`,
            type: "tool_call",
            messageId: entry.id,
            turnId,
            callId: block.id,
            toolCallId: block.id,
            toolName: block.name,
            args: sanitizeToolValue(block.arguments),
            status: outcome === undefined ? "no_result" : outcome ? "error" : "completed",
            order: order++,
            ...(timestamp ? { timestamp } : {}),
          });
          emittedMessageOrTool = true;
        }
      }
      // Keep image-only/prototype metadata messages addressable without inventing text.
      if (!emittedMessageOrTool) {
        timeline.push({ id: `assistant-message:${entry.id}`, type: "message", role: "assistant", messageId: entry.id, turnId, text: "", order: messageOrder, ...(timestamp ? { timestamp } : {}) });
        order += 1;
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string" && typeof message.toolName === "string" && typeof message.isError === "boolean") {
      const owner = calls.get(message.toolCallId);
      timeline.push({
        id: `tool-result:${entry.id}`,
        type: "tool_result",
        messageId: owner?.messageId ?? null,
        turnId: owner?.turnId ?? turnId,
        callId: message.toolCallId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        result: sanitizeToolResult(message.content, message.details),
        isError: message.isError,
        order: order++,
        ...(timestamp ? { timestamp } : {}),
      });
    }
  }
  return { messages: legacy, timeline };
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => asRecord(block)).filter((block): block is ContentBlock => block?.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("");
}

function hasVisibleAssistantContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((value) => {
    const block = asRecord(value);
    return block?.type === "text" || block?.type === "image" || block?.type === "prototype" || block?.type === "toolCall";
  });
}

type FailbackEvent = { from: string; to: string; reason: string };
function failbackPresentation(branch: readonly SessionEntry[]): { events: Map<string, FailbackEvent>; hiddenContinuationIds: Set<string> } {
  const events = new Map<string, FailbackEvent>();
  const hiddenContinuationIds = new Set<string>();
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index] as SessionEntry & { customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== "model-failback") continue;
    const data = asRecord(entry.data);
    // The customType is the persisted extension marker; do not infer this from user text.
    if (!data || typeof data.from !== "string" || typeof data.to !== "string" || typeof data.reason !== "string") continue;
    events.set(entry.id, { from: data.from, to: data.to, reason: data.reason });
    const continuation = failbackContinuationAfter(branch, index, entry.id);
    if (!continuation) continue;
    const text = exactUserText(continuation.message.content);
    // New markers provide an unambiguous exact value. Before that field existed, the engine
    // emitted the complete legacy template below, with a human-readable failure note that was
    // deliberately not duplicated in the marker's machine-readable `reason` field.
    const expected = typeof data.continuation === "string" ? data.continuation : null;
    if (text !== null && (expected !== null ? text === expected : isLegacyFailbackContinuation(text, data))) {
      hiddenContinuationIds.add(continuation.id);
    }
  }
  return { events, hiddenContinuationIds };
}

type UserMessageEntry = MessageEntry & { message: { role: "user"; content?: unknown } };

/**
 * Pi inserts the failed terminal assistant entry between the extension marker and its steer.
 * Follow only that empty terminal-error link; any other entry or broken parent chain is
 * ambiguous and remains visible.
 */
function failbackContinuationAfter(branch: readonly SessionEntry[], markerIndex: number, markerId: string): UserMessageEntry | null {
  let previousId = markerId;
  let index = markerIndex + 1;
  while (true) {
    const entry = branch[index];
    if (!entry || entry.type !== "message" || entry.parentId !== previousId) return null;
    const message = entry.message as { role?: unknown; content?: unknown; stopReason?: unknown };
    if (message.role === "user") return entry as UserMessageEntry;
    // Do not skip a partial/error response: only Pi's empty terminal error is internal plumbing.
    if (message.role !== "assistant" || message.stopReason !== "error" || !isEmptyContent(message.content)) return null;
    previousId = entry.id;
    index += 1;
  }
}

function isEmptyContent(content: unknown): boolean {
  return Array.isArray(content) && content.length === 0;
}

const LEGACY_FAILBACK_PREFIX = "[model-failback] 之前的模型(";
const LEGACY_FAILBACK_AFTER_SOURCE = ")发生终态错误(";
const LEGACY_FAILBACK_AFTER_REASON = ")。已切换到备用模型(";
const LEGACY_FAILBACK_SUFFIX = "),请继续完成之前的任务,不要重复已完成的步骤。";

/** Exact old-engine scaffold, including its Chinese full stop and ASCII commas/spaces. */
function isLegacyFailbackContinuation(text: string, data: ContentBlock): boolean {
  if (typeof data.from !== "string" || typeof data.to !== "string") return false;
  const prefix = `${LEGACY_FAILBACK_PREFIX}${data.from}${LEGACY_FAILBACK_AFTER_SOURCE}`;
  const suffix = `${LEGACY_FAILBACK_AFTER_REASON}${data.to}${LEGACY_FAILBACK_SUFFIX}`;
  // The old marker has no continuation/failure-note field. The note is the only dynamic slot;
  // require it to be present and all surrounding generated text to be exact.
  return text.startsWith(prefix) && text.endsWith(suffix) && text.length > prefix.length + suffix.length;
}

function exactUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  let text = "";
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type !== "text" || typeof block.text !== "string") return null;
    text += block.text;
  }
  return text;
}

function forEachToolCall(content: unknown, callback: (block: ContentBlock) => void): void {
  if (!Array.isArray(content)) return;
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type === "toolCall") callback(block);
  }
}

function sanitizeToolResult(content: unknown, details: unknown): unknown {
  const result: Record<string, unknown> = { content: sanitizeToolValue(content) };
  if (details !== undefined) result.details = sanitizeToolValue(details);
  return result;
}

const SENSITIVE_KEY = /(?:authorization|cookie|(?:api[ _-]?)?key|token|secret|password|credential|bearer)/i;

/** No size cap: persisted text/JSON is retained verbatim. Only secrets and image binary are removed. */
const MAX_EXPORT_JSON_DEPTH = 512;
const UNAVAILABLE = (reason: string) => ({ type: "export_unavailable", reason });

/**
 * Stack-safe JSON clone for tool values. There is deliberately no item/string size cap.
 * Extremely nested, cyclic, or non-JSON values become explicit display placeholders so one
 * malformed tool payload cannot make the entire HTTP export unstringifiable.
 */
export function sanitizeToolValue(value: unknown): unknown {
  const primitive = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : UNAVAILABLE("non_finite_number");
    return null;
  };
  if (value === null || typeof value !== "object") {
    return typeof value === "undefined" ? UNAVAILABLE("undefined") :
      (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" ? UNAVAILABLE(`non_json_${typeof value}`) : primitive(value));
  }
  const root: { value: unknown } = { value: undefined };
  const seen = new WeakSet<object>();
  type Work = { input: object; target: Record<string, unknown> | unknown[]; depth: number };
  const makeContainer = (input: object, depth: number): Record<string, unknown> | unknown[] | ReturnType<typeof UNAVAILABLE> => {
    if (depth > MAX_EXPORT_JSON_DEPTH) return UNAVAILABLE("nesting_too_deep");
    if (seen.has(input)) return UNAVAILABLE("cyclic_or_repeated_reference");
    seen.add(input);
    return Array.isArray(input) ? [] : {};
  };
  const initial = makeContainer(value, 0);
  root.value = initial;
  if (!Array.isArray(initial) && (initial as Record<string, unknown>).type === "export_unavailable") return initial;
  const work: Work[] = [{ input: value, target: initial as Record<string, unknown> | unknown[], depth: 0 }];
  while (work.length > 0) {
    const current = work.pop()!;
    let entries: [string, unknown][];
    try { entries = Object.entries(current.input); } catch { entries = [["value", UNAVAILABLE("unreadable_object")]]; }
    const image = !Array.isArray(current.input) && (current.input as { type?: unknown }).type === "image";
    for (const [key, child] of entries) {
      let next: unknown;
      if (SENSITIVE_KEY.test(key)) next = "[REDACTED]";
      else if (image && (key === "data" || key === "base64")) next = "[BINARY_OMITTED]";
      else if (child !== null && typeof child === "object") {
        const container = makeContainer(child, current.depth + 1);
        next = container;
        if (!(!Array.isArray(container) && (container as { type?: unknown }).type === "export_unavailable")) {
          work.push({ input: child, target: container as Record<string, unknown> | unknown[], depth: current.depth + 1 });
        }
      } else if (typeof child === "undefined") next = UNAVAILABLE("undefined");
      else if (typeof child === "bigint" || typeof child === "function" || typeof child === "symbol") next = UNAVAILABLE(`non_json_${typeof child}`);
      else next = primitive(child);
      if (Array.isArray(current.target)) current.target.push(next);
      else current.target[key] = next;
    }
  }
  return root.value;
}

function asRecord(value: unknown): ContentBlock | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as ContentBlock : null;
}
