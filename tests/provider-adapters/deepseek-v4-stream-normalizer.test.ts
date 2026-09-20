import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekV4DsmlTextToolParser } from "../../src/provider-adapters/deepseek-v4/dsml-text-tool-parser.js";
import {
  createDeepSeekV4StreamAdapter,
  deepSeekStreamAdapter,
  openCodeDeepSeekStreamAdapter,
  DEEPSEEK_PROVIDERS,
  isDirectDeepSeekModel,
  isOpenCodeDeepSeekModel,
  OPENCODE_PROVIDERS,
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

/**
 * 测试用假上游：将「模型输出的整段文本」作为一个 text 事件流出去。
 *
 * 只有需要驱动**导出的**适配器时才用到它：导出的适配器内部持有默认的
 * `openAICompletionsApi().streamSimple`（会真发网），所以必须拦在 compat 层。
 */
const compatState = vi.hoisted(() => ({
  base: undefined as undefined | ((model: never, context: never, options?: never) => unknown),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  return {
    ...actual,
    openAICompletionsApi: () => {
      const original = actual.openAICompletionsApi();
      return {
        ...original,
        streamSimple: (model: never, context: never, options?: never) =>
          compatState.base
            ? compatState.base(model, context, options)
            : original.streamSimple(model, context, options),
      };
    },
  };
});

/** DSML 帧构造（全角竖线用转义写，避免源码里出现不可见字符）。 */
const DSML_BAR = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
function dsmlCall(name: string, param: string, value: string): string {
  return (
    `<${DSML_BAR}tool_calls><${DSML_BAR}invoke name="${name}">` +
    `<${DSML_BAR}parameter name="${param}" string="true">${value}</${DSML_BAR}parameter>` +
    `</${DSML_BAR}invoke></${DSML_BAR}tool_calls>`
  );
}

function tool(name: string) {
  return { name, description: name, parameters: {} };
}

/** 直接用 messages 构造已归一化的流式 context（支持多轮系统消息差量）。 */
function transcriptFrom(messages: Message[]): TranscriptContext {
  return normalizeContext({ messages });
}

/**
 * 构造 SDK 归一化后的流式 context。0.86.0 起 provider 收到的是 `TranscriptContext`：
 * 只有 messages，工具集声明在 leading system message 的 `toolsAdded` 上。
 */
function transcript(toolNames: readonly string[]): TranscriptContext {
  return transcriptFrom(
    toolNames.length === 0
      ? []
      : [{ role: "system", content: "", toolsAdded: toolNames.map(tool), timestamp: 0 }],
  );
}

function deepSeekV4FlashModel(): Model<Api> {
  return { provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" } as never;
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
  it("按 provider + id 子串匹配 DeepSeek 家族，不依赖会改名的精确 id", () => {
    // 0.85.1 -> 0.86.0 的 id 改名不能重演：这些旧 id 与新 id 都必须命中。
    for (const id of ["deepseek-v4-flash", "deepseek-flash"]) {
      expect(isDirectDeepSeekModel({ provider: "deepseek", id })).toBe(true);
    }
    expect(isDirectDeepSeekModel({ provider: "deepseek", id: "deepseek-v4-pro" })).toBe(true);
    for (const id of ["deepseek-v4-flash-free", "deepseek-v4-flash", "deepseek-v4.1-flash"]) {
      expect(isOpenCodeDeepSeekModel({ provider: "opencode", id })).toBe(true);
    }
    // provider 必须精确匹配：同名的开源/聚合 provider 不走本地适配器。
    expect(isDirectDeepSeekModel({ provider: "openrouter", id: "deepseek-v4-flash" })).toBe(false);
    // opencode 与 opencode-go 同厂同模型 id，共用 DSML 适配器，两者都要命中。
    expect(isOpenCodeDeepSeekModel({ provider: "opencode-go", id: "deepseek-v4-flash" })).toBe(true);
    expect(isDirectDeepSeekModel({ provider: "opencode-go", id: "deepseek-v4-flash" })).toBe(false);
    // 非 DeepSeek 模型一概不介入。
    expect(isDirectDeepSeekModel({ provider: "deepseek", id: "gpt-5" })).toBe(false);
    expect(isOpenCodeDeepSeekModel({ provider: "opencode", id: "gpt-5" })).toBe(false);
  });

  it("每个已注册 provider 至少命中一个真实 catalog 模型（防静默死代码）", async () => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    const providers = builtinProviders();
    // 与 start.ts 的注册面一一对应：改这里必须同步改注册。
    const registered = [
      ...DEEPSEEK_PROVIDERS.map((id) => [id, isDirectDeepSeekModel] as const),
      ...OPENCODE_PROVIDERS.map((id) => [id, isOpenCodeDeepSeekModel] as const),
    ];
    expect(registered.map(([id]) => id)).toEqual(["deepseek", "opencode", "opencode-go"]);
    for (const [providerId, matches] of registered) {
      const provider = providers.find((candidate) => candidate.id === providerId);
      expect(provider, `catalog 中缺少 provider ${providerId}`).toBeDefined();
      const matched = provider!.getModels().filter((model) => matches(model)).map((model) => model.id);
      // 精确 id 匹配时期这里会是 0 而不会有任何报错，这正是本次要防的失效模式。
      expect(matched, `${providerId} 下没有任何模型命中适配器匹配规则`).not.toHaveLength(0);
    }
  });

  it("源流未给出 start / 终态事件时，兜底消息携带真实身份而非写死的退役 id", async () => {
    const base = () => source([]); // 空流：既无 start 也无终态事件
    const adapter = createDeepSeekV4StreamAdapter(isOpenCodeDeepSeekModel, {}, base);
    const events = await collect(
      adapter(
        { provider: "opencode-go", id: "deepseek-v4.1-flash", api: "openai-completions" } as never,
        transcript(["read"]),
        undefined,
      ),
    );
    const final = events.at(-1);
    if (final?.type !== "error") throw new Error("expected error");
    // 旧实现会写死 provider="deepseek" / model="deepseek-v4-flash"（已退役的 id）。
    expect(final.error.provider).toBe("opencode-go");
    expect(final.error.model).toBe("deepseek-v4.1-flash");
  });

  it("非目标模型严格使用原始 stream", async () => {
    const passthrough = source([{ type: "start", partial: message([]) }]);
    const base = () => passthrough;
    const adapter = createDeepSeekV4StreamAdapter(isDirectDeepSeekModel, {}, base);
    const model = {
      provider: "deepseek",
      id: "gpt-5",
      api: "openai-completions",
    } as never;
    expect(adapter(model, transcript([]))).toBe(passthrough);
  });

  /**
   * 回归护栏：SDK 在调用 provider 前已 `normalizeContext()`，adapter 收到的是
   * `TranscriptContext`（只有 messages），工具集必须从 transcript 的 system message 回放。
   * 直接读 `context.tools` 会得到空集，把已授权工具的文本标记也放行为原生调用（fail-open）。
   */
  it("从 TranscriptContext 回放工具集：已授权文本标记不执行，未授权仍转原生调用", async () => {
    const authorized = '<use_tool name="read"><param name="path">a</param></use_tool>';
    const unauthorized = '<use_tool name="bash"><param name="command">ls</param></use_tool>';

    const run = async (text: string) => {
      const start = message([]);
      const partial = message([{ type: "text", text: "" }]);
      const done = message([{ type: "text", text }]);
      done.stopReason = "stop";
      const events = await collect(
        createDeepSeekV4StreamAdapter(isDirectDeepSeekModel, {}, () =>
          source([
            { type: "start", partial: start },
            { type: "text_start", contentIndex: 0, partial },
            { type: "text_delta", contentIndex: 0, delta: text, partial },
            { type: "text_end", contentIndex: 0, content: text, partial: done },
            { type: "done", reason: "stop", message: done },
          ]),
        )(deepSeekV4FlashModel(), transcript(["read"]), undefined),
      );
      const final = events.at(-1);
      if (final?.type !== "done") throw new Error("expected done");
      return final;
    };

    // 已授权：文本标记隐藏，不产生任何 toolcall。
    const authorizedFinal = await run(authorized);
    expect(authorizedFinal.reason).toBe("stop");
    expect(authorizedFinal.message.content).toEqual([
      { type: "text", text: "工具 read 的非原生文本调用未执行。" },
    ]);

    // 未授权：转为原生未知调用，交给 Pi 返回标准拒绝结果。
    const unauthorizedFinal = await run(unauthorized);
    expect(unauthorizedFinal.reason).toBe("toolUse");
    expect(unauthorizedFinal.message.content).toEqual([
      { type: "toolCall", id: "deepseek-v4-flash-text-1", name: "bash", arguments: { command: "ls" } },
    ]);
  });

  it("多轮 transcript 的 toolsRemoved / toolsAdded 差量会被回放，授权面随之变化", async () => {
    // 第一轮声明 read+bash，第二轮移除 read、新增 edit。
    // `getCurrentTools` 按顺序应用差量，所以当下授权面 = { bash, edit }。
    const context = transcriptFrom([
      { role: "system", content: "", toolsAdded: [tool("read"), tool("bash")], timestamp: 0 },
      { role: "system", content: "", toolsRemoved: [{ name: "read" }], toolsAdded: [tool("edit")], timestamp: 1 },
    ]);

    const run = async (text: string) => {
      const start = message([]);
      const partial = message([{ type: "text", text: "" }]);
      const done = message([{ type: "text", text }]);
      done.stopReason = "stop";
      const events = await collect(
        createDeepSeekV4StreamAdapter(isDirectDeepSeekModel, {}, () =>
          source([
            { type: "start", partial: start },
            { type: "text_start", contentIndex: 0, partial },
            { type: "text_delta", contentIndex: 0, delta: text, partial },
            { type: "text_end", contentIndex: 0, content: text, partial: done },
            { type: "done", reason: "stop", message: done },
          ]),
        )(deepSeekV4FlashModel(), context, undefined),
      );
      const final = events.at(-1);
      if (final?.type !== "done") throw new Error("expected done");
      return final;
    };

    // 第二轮新增的 edit 已授权 → 不执行。
    const edited = await run('<use_tool name="edit"><param name="path">a</param></use_tool>');
    expect(edited.reason).toBe("stop");
    expect(edited.message.content).toEqual([{ type: "text", text: "工具 edit 的非原生文本调用未执行。" }]);

    // 第二轮被移除的 read 已不再授权 → 转为原生调用（旧实现会把它当已授权而拒绝）。
    const read = await run('<use_tool name="read"><param name="path">a</param></use_tool>');
    expect(read.reason).toBe("toolUse");
    expect(read.message.content).toEqual([
      { type: "toolCall", id: "deepseek-v4-flash-text-1", name: "read", arguments: { path: "a" } },
    ]);
  });
});

describe("协议归属：导出的适配器绑定到正确的 parser", () => {
  /** 在 compat 层接管假上游，从而驱动真实的导出适配器（而非本地重建的实例）。 */
  const runExported = async (
    adapter: (model: never, context: TranscriptContext, options?: never) => AsyncIterable<AssistantMessageEvent>,
    model: Model<Api>,
    context: TranscriptContext,
    text: string,
  ) => {
    compatState.base = () => {
      const start = message([]);
      const partial = message([{ type: "text", text: "" }]);
      const done = message([{ type: "text", text }]);
      done.stopReason = "stop";
      return source([
        { type: "start", partial: start },
        { type: "text_start", contentIndex: 0, partial },
        { type: "text_delta", contentIndex: 0, delta: text, partial },
        { type: "text_end", contentIndex: 0, content: text, partial: done },
        { type: "done", reason: "stop", message: done },
      ]);
    };
    try {
      const events = await collect(adapter(model as never, context, undefined as never));
      const final = events.at(-1);
      if (final?.type !== "done") throw new Error("expected done");
      return final;
    } finally {
      compatState.base = undefined;
    }
  };

  const deepseekModel = { provider: "deepseek", id: "deepseek-flash", api: "openai-completions" } as Model<Api>;
  const openCodeGoModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", api: "openai-completions" } as Model<Api>;

  it("deepseek 说 <use_tool>：已授权标记被拒绝执行，DSML 不被它识别", async () => {
    const useTool = await runExported(deepSeekStreamAdapter, deepseekModel, transcript(["read"]), '<use_tool name="read"><param name="path">a</param></use_tool>');
    expect(useTool.reason).toBe("stop");
    expect(useTool.message.content).toEqual([{ type: "text", text: "工具 read 的非原生文本调用未执行。" }]);

    // 交叉协议必须退化为透传（而不是被误当成工具调用）。
    const dsml = await runExported(deepSeekStreamAdapter, deepseekModel, transcript(["read"]), dsmlCall("read", "path", "a"));
    expect(dsml.reason).toBe("stop");
    expect(dsml.message.content).toEqual([{ type: "text", text: dsmlCall("read", "path", "a") }]);
  });

  it("opencode-go 走 DSML：已授权标记被拒绝执行，<use_tool> 不被它识别", async () => {
    const dsml = await runExported(openCodeDeepSeekStreamAdapter, openCodeGoModel, transcript(["read"]), dsmlCall("read", "path", "a"));
    expect(dsml.reason).toBe("stop");
    expect(dsml.message.content).toEqual([{ type: "text", text: "工具 read 的非原生文本调用未执行。" }]);

    const useToolText = '<use_tool name="read"><param name="path">a</param></use_tool>';
    const useTool = await runExported(openCodeDeepSeekStreamAdapter, openCodeGoModel, transcript(["read"]), useToolText);
    expect(useTool.reason).toBe("stop");
    expect(useTool.message.content).toEqual([{ type: "text", text: useToolText }]);
  });

  it("两个适配器只命中自己的 provider（归属不重叠）", async () => {
    const openCodeModel = { provider: "opencode", id: "deepseek-v4-flash", api: "openai-completions" } as Model<Api>;
    const useToolText = '<use_tool name="read"><param name="path">a</param></use_tool>';
    const dsmlText = dsmlCall("read", "path", "a");
    const REFUSAL = "工具 read 的非原生文本调用未执行。";

    // 每个适配器喂**它自己的**协议标记：命中则转成拒绍文本，未命中则原样透传。
    const cases = [
      [deepSeekStreamAdapter, useToolText, deepseekModel, true],
      [deepSeekStreamAdapter, useToolText, openCodeModel, false],
      [deepSeekStreamAdapter, useToolText, openCodeGoModel, false],
      [openCodeDeepSeekStreamAdapter, dsmlText, openCodeModel, true],
      [openCodeDeepSeekStreamAdapter, dsmlText, openCodeGoModel, true],
      [openCodeDeepSeekStreamAdapter, dsmlText, deepseekModel, false],
    ] as const;

    for (const [adapter, text, model, expected] of cases) {
      const final = await runExported(adapter, model, transcript(["read"]), text);
      const adapted = final.message.content.some((block) => block.type === "text" && block.text === REFUSAL);
      expect(adapted, `${model.provider}/${model.id}`).toBe(expected);
    }
  });
});
