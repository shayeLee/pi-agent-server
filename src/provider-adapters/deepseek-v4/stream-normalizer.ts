import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { DeepSeekV4TextToolParser, type DeepSeekV4TextToolEvent } from "./text-tool-parser.js";

type AssistantContent = AssistantMessage["content"][number];
type TextState = {
  parser: DeepSeekV4TextToolParserLike;
  sawDelta: boolean;
  activeTextIndex?: number;
};

export type DeepSeekV4TextToolParserLike = {
  push(delta: string): DeepSeekV4TextToolEvent[];
  finish(): DeepSeekV4TextToolEvent[];
};

export type DeepSeekV4StreamNormalizationOptions = {
  /** Pi 当前原生注册的工具名。文本标记绝不能绕过这些实际权限。 */
  allowedToolNames?: readonly string[];
  parserFactory?: () => DeepSeekV4TextToolParserLike;
};

/**
 * Converts DeepSeek V4 Flash's textual <use_tool> protocol into Pi's native
 * AssistantMessageEvent protocol. This is deliberately an event-stream-only
 * adapter: it never invokes, authorizes, or otherwise handles a tool.
 */
export function normalizeDeepSeekV4FlashStream(
  source: AsyncIterable<AssistantMessageEvent>,
  options: DeepSeekV4StreamNormalizationOptions = {},
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const allowedToolNames = new Set(options.allowedToolNames ?? []);
  const parserFactory = options.parserFactory ?? (() => new DeepSeekV4TextToolParser());
  let message: AssistantMessage | undefined;
  let terminal = false;
  let hasToolCall = false;
  let generatedToolCallNumber = 0;
  const textStates = new Map<number, TextState>();
  const nativeIndexes = new Map<number, number>();

  const ensureMessage = (): AssistantMessage => {
    if (message) return message;
    message = emptyMessage();
    return message;
  };

  const adoptPartial = (partial: AssistantMessage): AssistantMessage => {
    const current = ensureMessage();
    message = { ...partial, content: current.content };
    return message;
  };

  const pushTextStart = (contentIndex: number): void => {
    output.push({ type: "text_start", contentIndex, partial: snapshot(ensureMessage()) });
  };

  const pushTextDelta = (contentIndex: number, delta: string): void => {
    output.push({ type: "text_delta", contentIndex, delta, partial: snapshot(ensureMessage()) });
  };

  const closeText = (state: TextState): void => {
    if (state.activeTextIndex === undefined) return;
    const block = ensureMessage().content[state.activeTextIndex];
    if (block?.type === "text") {
      output.push({
        type: "text_end",
        contentIndex: state.activeTextIndex,
        content: block.text,
        partial: snapshot(ensureMessage()),
      });
    }
    state.activeTextIndex = undefined;
  };

  const appendText = (state: TextState, text: string): void => {
    if (!text) return;
    if (state.activeTextIndex === undefined) {
      const contentIndex = ensureMessage().content.length;
      ensureMessage().content.push({ type: "text", text: "" });
      state.activeTextIndex = contentIndex;
      pushTextStart(contentIndex);
    }
    const contentIndex = state.activeTextIndex;
    const block = ensureMessage().content[contentIndex];
    if (block?.type !== "text") return;
    block.text += text;
    pushTextDelta(contentIndex, text);
  };

  const appendToolCall = (
    state: TextState,
    event: Extract<DeepSeekV4TextToolEvent, { type: "tool_call" }>,
  ): void => {
    // 文本协议无法区分“模型真正调用”与“模型引用/复述的 XML”。
    // 已授权工具绝不由文本标记触发执行；隐藏标记并说明未执行。未授权名称
    // 才安全地转为原生未知调用，让 Pi 返回标准的拒绝结果。
    if (allowedToolNames.has(event.name)) {
      appendText(state, `工具 ${event.name} 的非原生文本调用未执行。`);
      return;
    }

    closeText(state);
    hasToolCall = true;
    const toolCall: ToolCall = {
      type: "toolCall",
      id: `deepseek-v4-flash-text-${++generatedToolCallNumber}`,
      name: event.name,
      arguments: { ...event.arguments },
    };
    const contentIndex = ensureMessage().content.length;
    ensureMessage().content.push(toolCall);
    output.push({ type: "toolcall_start", contentIndex, partial: snapshot(ensureMessage()) });
    const delta = JSON.stringify(toolCall.arguments);
    output.push({ type: "toolcall_delta", contentIndex, delta, partial: snapshot(ensureMessage()) });
    output.push({ type: "toolcall_end", contentIndex, toolCall: { ...toolCall, arguments: { ...toolCall.arguments } }, partial: snapshot(ensureMessage()) });
  };

  const processTextEvent = (state: TextState, event: DeepSeekV4TextToolEvent): void => {
    switch (event.type) {
      case "text":
        appendText(state, event.text);
        return;
      case "tool_call":
        appendToolCall(state, event);
        return;
      case "protocol_error":
        // The parser intentionally withholds the incomplete/malformed frame;
        // dropping this notification here ensures the markup cannot escape as text.
        closeText(state);
        return;
    }
  };

  const finishTextStates = (): void => {
    for (const state of textStates.values()) {
      for (const event of state.parser.finish()) processTextEvent(state, event);
      closeText(state);
    }
    textStates.clear();
  };

  const sourceBlock = (event: { partial: AssistantMessage; contentIndex: number }): AssistantContent | undefined => {
    const block = event.partial.content[event.contentIndex];
    return block ? cloneContent(block) : undefined;
  };

  const appendNativeBlock = (
    sourceIndex: number,
    block: AssistantContent,
  ): number => {
    const existing = nativeIndexes.get(sourceIndex);
    if (existing !== undefined) return existing;
    const outputIndex = ensureMessage().content.length;
    ensureMessage().content.push(block);
    nativeIndexes.set(sourceIndex, outputIndex);
    return outputIndex;
  };

  const syncNativeBlock = (sourceIndex: number, partial: AssistantMessage): number | undefined => {
    const outputIndex = nativeIndexes.get(sourceIndex);
    const block = partial.content[sourceIndex];
    if (outputIndex === undefined || !block || block.type === "text") return outputIndex;
    ensureMessage().content[outputIndex] = cloneContent(block);
    return outputIndex;
  };

  const processEvent = (event: AssistantMessageEvent): void => {
    switch (event.type) {
      case "start":
        message = { ...event.partial, content: [] };
        output.push({ type: "start", partial: snapshot(message) });
        return;

      case "text_start":
        adoptPartial(event.partial);
        textStates.set(event.contentIndex, { parser: parserFactory(), sawDelta: false });
        return;

      case "text_delta": {
        const state = textStates.get(event.contentIndex);
        if (!state) return;
        adoptPartial(event.partial);
        state.sawDelta = true;
        for (const parsed of state.parser.push(event.delta)) processTextEvent(state, parsed);
        return;
      }

      case "text_end": {
        const state = textStates.get(event.contentIndex);
        if (!state) return;
        adoptPartial(event.partial);
        if (!state.sawDelta && event.content) {
          for (const parsed of state.parser.push(event.content)) processTextEvent(state, parsed);
        }
        for (const parsed of state.parser.finish()) processTextEvent(state, parsed);
        closeText(state);
        textStates.delete(event.contentIndex);
        return;
      }

      case "thinking_start": {
        const partial = adoptPartial(event.partial);
        const block = sourceBlock(event) ?? { type: "thinking", thinking: "" } satisfies ThinkingContent;
        const contentIndex = appendNativeBlock(event.contentIndex, block);
        output.push({ type: "thinking_start", contentIndex, partial: snapshot(partial) });
        return;
      }

      case "thinking_delta": {
        adoptPartial(event.partial);
        // Pi 的 partial 已含累计 thinking；不能从它复制后再附加 delta，否则会重复。
        const contentIndex = nativeIndexes.get(event.contentIndex);
        if (contentIndex === undefined) return;
        const block = ensureMessage().content[contentIndex];
        if (block?.type === "thinking") block.thinking += event.delta;
        output.push({ type: "thinking_delta", contentIndex, delta: event.delta, partial: snapshot(ensureMessage()) });
        return;
      }

      case "thinking_end": {
        const partial = adoptPartial(event.partial);
        const contentIndex = syncNativeBlock(event.contentIndex, partial);
        if (contentIndex === undefined) return;
        const block = ensureMessage().content[contentIndex];
        if (block?.type === "thinking") block.thinking = event.content;
        output.push({ type: "thinking_end", contentIndex, content: event.content, partial: snapshot(ensureMessage()) });
        return;
      }

      case "toolcall_start": {
        hasToolCall = true;
        const partial = adoptPartial(event.partial);
        const block = sourceBlock(event) ?? ({ type: "toolCall", id: `native-${event.contentIndex}`, name: "", arguments: {} } satisfies ToolCall);
        const contentIndex = appendNativeBlock(event.contentIndex, block);
        output.push({ type: "toolcall_start", contentIndex, partial: snapshot(partial) });
        return;
      }

      case "toolcall_delta": {
        const partial = adoptPartial(event.partial);
        const contentIndex = syncNativeBlock(event.contentIndex, partial);
        if (contentIndex === undefined) return;
        output.push({ type: "toolcall_delta", contentIndex, delta: event.delta, partial: snapshot(ensureMessage()) });
        return;
      }

      case "toolcall_end": {
        const partial = adoptPartial(event.partial);
        const contentIndex = nativeIndexes.get(event.contentIndex);
        if (contentIndex === undefined) return;
        ensureMessage().content[contentIndex] = cloneContent(event.toolCall);
        output.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: { ...event.toolCall, arguments: { ...event.toolCall.arguments } },
          partial: snapshot(ensureMessage()),
        });
        return;
      }

      case "done": {
        adoptPartial(event.message);
        finishTextStates();
        const reason = hasToolCall && event.reason === "stop" ? "toolUse" : event.reason;
        const finalMessage = ensureMessage();
        finalMessage.stopReason = reason;
        terminal = true;
        output.push({ type: "done", reason, message: snapshot(finalMessage) });
        return;
      }

      case "error":
        adoptPartial(event.error);
        finishTextStates();
        terminal = true;
        output.push({ type: "error", reason: event.reason, error: snapshot(ensureMessage()) });
        return;
    }
  };

  void (async () => {
    try {
      for await (const event of source) processEvent(event);
      if (!terminal) {
        finishTextStates();
        const failed = ensureMessage();
        failed.stopReason = "error";
        failed.errorMessage = "Provider stream ended without a terminal event";
        output.push({ type: "error", reason: "error", error: snapshot(failed) });
      }
      output.end();
    } catch (error) {
      if (!terminal) {
        finishTextStates();
        const failed = ensureMessage();
        failed.stopReason = "error";
        failed.errorMessage = error instanceof Error ? error.message : String(error);
        output.push({ type: "error", reason: "error", error: snapshot(failed) });
      }
      output.end();
    }
  })();

  return output;
}

function emptyMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function cloneContent(content: AssistantContent): AssistantContent {
  if (content.type === "text") return { ...content } satisfies TextContent;
  if (content.type === "thinking") return { ...content } satisfies ThinkingContent;
  return { ...content, arguments: { ...content.arguments } };
}

function snapshot(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map(cloneContent),
    usage: { ...message.usage, cost: { ...message.usage.cost } },
  };
}
