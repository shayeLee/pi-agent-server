import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DeepSeekV4DsmlTextToolParser } from "../../src/provider-adapters/deepseek-v4/dsml-text-tool-parser.js";
import {
  createDeepSeekV4StreamAdapter,
  isDirectDeepSeekV4Flash,
  isOpenCodeDeepSeekV4FlashFree,
} from "../../src/provider-adapters/deepseek-v4/provider-adapter.js";
import { normalizeDeepSeekV4FlashStream } from "../../src/provider-adapters/deepseek-v4/stream-normalizer.js";

function message(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
    },
    stopReason: "pending",
    timestamp: 1,
  };
}

function source(events: AssistantMessageEvent[]): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  stream.end();
  return stream;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("normalizeDeepSeekV4FlashStream", () => {
  it("跨 text chunk 转成原生 toolcall，并完全隐藏帧标记", async () => {
    const start = message([]);
    const textPartial = message([{ type: "text", text: "" }]);
    const done = message([
      {
        type: "text",
        text: '<use_tool name="bash"><param name="command">ls</param></use_tool>',
      },
    ]);
    done.stopReason = "stop";

    const events = await collect(
      normalizeDeepSeekV4FlashStream(
        source([
          { type: "start", partial: start },
          { type: "text_start", contentIndex: 0, partial: textPartial },
          { type: "text_delta", contentIndex: 0, delta: "<use_", partial: textPartial },
          { type: "text_delta", contentIndex: 0, delta: 'tool name="bash"><param name="command">ls</param>', partial: textPartial },
          { type: "text_delta", contentIndex: 0, delta: "</use_tool>", partial: textPartial },
          { type: "text_end", contentIndex: 0, content: done.content[0]?.type === "text" ? done.content[0].text : "", partial: done },
          { type: "done", reason: "stop", message: done },
        ]),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const final = events.at(-1);
    expect(final?.type).toBe("done");
    if (final?.type !== "done") return;
    expect(final.reason).toBe("toolUse");
    expect(final.message.stopReason).toBe("toolUse");
    expect(final.message.content).toEqual([
      {
        type: "toolCall",
        id: "deepseek-v4-flash-text-1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("<use_tool");
  });

  it("保留普通 text、thinking、native toolcall 和 usage", async () => {
    const thinking = { type: "thinking" as const, thinking: "reason" };
    const nativeTool: ToolCall = { type: "toolCall", id: "native-1", name: "read", arguments: { path: "a" } };
    const start = message([]);
    const thinkingStartPartial = message([{ type: "thinking", thinking: "" }]);
    const thinkingPartial = message([thinking]);
    const textPartial = message([thinking, { type: "text", text: "" }]);
    const nativePartial = message([thinking, { type: "text", text: "hello" }, nativeTool]);
    const done = message([thinking, { type: "text", text: "hello" }, nativeTool]);
    done.stopReason = "toolUse";

    const events = await collect(
      normalizeDeepSeekV4FlashStream(
        source([
          { type: "start", partial: start },
          { type: "thinking_start", contentIndex: 0, partial: thinkingStartPartial },
          { type: "thinking_delta", contentIndex: 0, delta: "reason", partial: thinkingPartial },
          { type: "thinking_end", contentIndex: 0, content: "reason", partial: thinkingPartial },
          { type: "text_start", contentIndex: 1, partial: textPartial },
          { type: "text_delta", contentIndex: 1, delta: "hello", partial: textPartial },
          { type: "text_end", contentIndex: 1, content: "hello", partial: nativePartial },
          { type: "toolcall_start", contentIndex: 2, partial: nativePartial },
          { type: "toolcall_delta", contentIndex: 2, delta: '{"path":"a"}', partial: nativePartial },
          { type: "toolcall_end", contentIndex: 2, toolCall: nativeTool, partial: done },
          { type: "done", reason: "toolUse", message: done },
        ]),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const final = events.at(-1);
    if (final?.type !== "done") throw new Error("expected done");
    expect(final.message.content).toEqual([thinking, { type: "text", text: "hello" }, nativeTool]);
    expect(final.message.usage).toEqual(done.usage);
  });

  it("将已确认的 Flash Free DSML 帧转换为未授权原生调用", async () => {
    const start = message([]);
    const partial = message([{ type: "text", text: "" }]);
    const dsml = '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="bash"><｜｜DSML｜｜parameter name="command" string="true">ls -al</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
    const done = message([{ type: "text", text: dsml }]);
    done.stopReason = "stop";

    const events = await collect(
      normalizeDeepSeekV4FlashStream(
        source([
          { type: "start", partial: start },
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: dsml, partial },
          { type: "text_end", contentIndex: 0, content: dsml, partial: done },
          { type: "done", reason: "stop", message: done },
        ]),
        { parserFactory: () => new DeepSeekV4DsmlTextToolParser() },
      ),
    );
    const final = events.at(-1);
    if (final?.type !== "done") throw new Error("expected done");
    expect(final.reason).toBe("toolUse");
    expect(final.message.content).toEqual([
      { type: "toolCall", id: "deepseek-v4-flash-text-1", name: "bash", arguments: { command: "ls -al" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("DSML");
  });

  it("已授权名称的文本标记不触发执行，也不泄露原标记", async () => {
    const start = message([]);
    const partial = message([{ type: "text", text: "" }]);
    const done = message([
      { type: "text", text: '<use_tool name="read"><param name="path">a</param></use_tool>' },
    ]);
    done.stopReason = "stop";

    const events = await collect(
      normalizeDeepSeekV4FlashStream(
        source([
          { type: "start", partial: start },
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: done.content[0]?.type === "text" ? done.content[0].text : "", partial },
          { type: "text_end", contentIndex: 0, content: done.content[0]?.type === "text" ? done.content[0].text : "", partial: done },
          { type: "done", reason: "stop", message: done },
        ]),
        { allowedToolNames: ["read"] },
      ),
    );

    expect(events.some((event) => event.type.startsWith("toolcall_"))).toBe(false);
    expect(JSON.stringify(events)).not.toContain("<use_tool");
    const final = events.at(-1);
    if (final?.type !== "done") throw new Error("expected done");
    expect(final.message.content).toEqual([{ type: "text", text: "工具 read 的非原生文本调用未执行。" }]);
  });

  it("畸形或未完成帧被丢弃，不以 text 或 partial 泄露", async () => {
    const start = message([]);
    const partial = message([{ type: "text", text: "before " }]);
    const done = message([{ type: "text", text: "before <use_tool name=broken" }]);
    done.stopReason = "stop";
    const events = await collect(
      normalizeDeepSeekV4FlashStream(
        source([
          { type: "start", partial: start },
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: "before <use_tool name=broken", partial },
          { type: "text_end", contentIndex: 0, content: done.content[0]?.type === "text" ? done.content[0].text : "", partial: done },
          { type: "done", reason: "stop", message: done },
        ]),
      ),
    );

    expect(JSON.stringify(events)).not.toContain("<use_tool");
    const final = events.at(-1);
    if (final?.type !== "done") throw new Error("expected done");
    expect(final.message.content).toEqual([{ type: "text", text: "before " }]);
  });
});

describe("deepseek provider adapter scope", () => {
  it("只匹配 direct deepseek/deepseek-v4-flash", () => {
    expect(isDirectDeepSeekV4Flash({ provider: "deepseek", id: "deepseek-v4-flash" })).toBe(true);
    expect(isDirectDeepSeekV4Flash({ provider: "deepseek", id: "deepseek-chat" })).toBe(false);
    expect(isDirectDeepSeekV4Flash({ provider: "openrouter", id: "deepseek-v4-flash" })).toBe(false);
    expect(isOpenCodeDeepSeekV4FlashFree({ provider: "opencode", id: "deepseek-v4-flash-free" })).toBe(true);
    expect(isOpenCodeDeepSeekV4FlashFree({ provider: "opencode-go", id: "deepseek-v4-flash-free" })).toBe(false);
  });

  it("非目标模型严格使用原始 stream", async () => {
    const passthrough = source([{ type: "start", partial: message([]) }]);
    const base = () => passthrough;
    const adapter = createDeepSeekV4StreamAdapter(isDirectDeepSeekV4Flash, {}, base);
    const model = {
      provider: "deepseek",
      id: "deepseek-chat",
      api: "openai-completions",
    } as never;
    expect(adapter(model, { messages: [] })).toBe(passthrough);
  });
});
