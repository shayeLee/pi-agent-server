import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import {
  getCurrentTools,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { DeepSeekV4DsmlTextToolParser } from "./dsml-text-tool-parser.js";
import { normalizeDeepSeekV4FlashStream, type DeepSeekV4StreamNormalizationOptions } from "./stream-normalizer.js";

/** 走 `<use_tool>` 文本协议的 provider。 */
export const DEEPSEEK_PROVIDERS = ["deepseek"] as const;

/**
 * 走 DSML 文本协议的 provider。
 *
 * `opencode`（baseUrl `https://opencode.ai/zen/v1`）有**真实观测**：
 * `tests/provider-adapters/fixtures/deepseek-v4/opencode-flash-free-dsml.json` 采集到真实 DSML 帧。
 *
 * `opencode-go`（baseUrl `https://opencode.ai/zen/go/v1`）与它同厂、携带**完全相同的** 4 个
 * deepseek 模型 id（`deepseek-v4-flash` / `-vision-exp` / `-v4-pro` / `v4.1-flash`），因此按同一
 * 协议挂载——但这是**推断而非观测**：`opencode-go-*.json` 只记录了「无工具时文本拒绝」，
 * `tool-matrix.json` 里有工具时记录的是 `native_tool_call`，没有 DSML 帧证据。
 *
 * 风险不对称，故可接受：若它实际说 `<use_tool>`，DSML parser 会把标记当普通文本透传，
 * 与不挂载等价；反之若它只是**复述/解释** DSML，该文本会被改写（因此拿到真实
 * `opencode-go` DSML 帧后应复核这条归属）。
 */
export const OPENCODE_PROVIDERS = ["opencode", "opencode-go"] as const;

/**
 * DeepSeek 家族模型 id 标记。
 *
 * catalog 的模型 id 会随 SDK 升级改名：0.86.0 把 `deepseek-v4-flash` 退役成
 * `deepseek-flash`、`deepseek-v4-flash-free` 退役成 `deepseek-v4-flash`，于是精确匹配
 * 让两个适配器**静默**变成死代码（无报错、无测试失败）。因此改为 provider + id 子串判定。
 *
 * 放宽匹配的代价可接受：parser 与本命协议不匹配时不会报错，只是把标记当普通文本透传，
 * 与「适配器完全不介入」等价；反之命中即可把文本协议转成原生调用。
 */
const DEEPSEEK_MODEL_ID_MARKER = "deepseek";

function isDeepSeekFamilyModel(
  model: Pick<Model<Api>, "provider" | "id">,
  providers: readonly string[],
): boolean {
  return providers.includes(model.provider) && model.id.toLowerCase().includes(DEEPSEEK_MODEL_ID_MARKER);
}

/** `deepseek` provider 下的 DeepSeek 家族模型（`<use_tool>` 文本协议）。 */
export function isDirectDeepSeekModel(model: Pick<Model<Api>, "provider" | "id">): boolean {
  return isDeepSeekFamilyModel(model, DEEPSEEK_PROVIDERS);
}

/** `opencode` / `opencode-go` provider 下的 DeepSeek 家族模型。 */
export function isOpenCodeDeepSeekModel(model: Pick<Model<Api>, "provider" | "id">): boolean {
  return isDeepSeekFamilyModel(model, OPENCODE_PROVIDERS);
}

type StreamSimple = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Wraps Pi's native OpenAI-compatible serializer without taking over tool
 * execution. The caller supplies the sole model-specific parsing profile.
 */
export function createDeepSeekV4StreamAdapter(
  matches: (model: Pick<Model<Api>, "provider" | "id">) => boolean,
  normalization: Omit<DeepSeekV4StreamNormalizationOptions, "allowedToolNames"> = {},
  // Do not call the global streamSimple dispatcher here: registering a provider
  // override would route back into this adapter recursively.
  baseStreamSimple: StreamSimple = openAICompletionsApi().streamSimple as StreamSimple,
): StreamSimple {
  return (model, context, options) => {
    const stream = baseStreamSimple(model, context, options);
    return matches(model)
      ? normalizeDeepSeekV4FlashStream(stream, {
          ...normalization,
          // 兜底消息必须携带真实 identity；写死 provider/model 会把改名后的模型
          // 标记成 `deepseek-v4-flash`（该 id 已在 0.86.0 退役）。
          identity: { api: model.api, provider: model.provider, model: model.id },
          // SDK 在调用 provider 前已 `normalizeContext()`，流式 context 是
          // `TranscriptContext`（只有 messages），systemPrompt/tools 被折叠进
          // transcript 的 system message；工具集必须经 `getCurrentTools()` 回放读取。
          // 直接读 `context.tools` 会恒为 undefined，从而让 allowedToolNames 变空集、
          // 把「已授权工具」的文本标记也放行成原生调用（fail-open）。
          allowedToolNames: getCurrentTools(context.messages).map((tool) => tool.name),
        })
      : stream;
  };
}

export const deepSeekStreamAdapter = createDeepSeekV4StreamAdapter(isDirectDeepSeekModel);
export const openCodeDeepSeekStreamAdapter = createDeepSeekV4StreamAdapter(
  isOpenCodeDeepSeekModel,
  { parserFactory: () => new DeepSeekV4DsmlTextToolParser() },
);
