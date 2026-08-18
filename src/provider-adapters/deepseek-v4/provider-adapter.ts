import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { DeepSeekV4DsmlTextToolParser } from "./dsml-text-tool-parser.js";
import { normalizeDeepSeekV4FlashStream, type DeepSeekV4StreamNormalizationOptions } from "./stream-normalizer.js";

export const DEEPSEEK_V4_FLASH_PROVIDER = "deepseek";
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const OPENCODE_V4_FLASH_FREE_PROVIDER = "opencode";
export const OPENCODE_V4_FLASH_FREE_MODEL = "deepseek-v4-flash-free";

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Only exact provider + model pairs may opt into a textual protocol adapter. */
export function isDirectDeepSeekV4Flash(model: Pick<Model<Api>, "provider" | "id">): boolean {
  return model.provider === DEEPSEEK_V4_FLASH_PROVIDER && model.id === DEEPSEEK_V4_FLASH_MODEL;
}

export function isOpenCodeDeepSeekV4FlashFree(model: Pick<Model<Api>, "provider" | "id">): boolean {
  return model.provider === OPENCODE_V4_FLASH_FREE_PROVIDER && model.id === OPENCODE_V4_FLASH_FREE_MODEL;
}

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
          allowedToolNames: context.tools?.map((tool) => tool.name),
        })
      : stream;
  };
}

export const deepSeekV4FlashStreamAdapter = createDeepSeekV4StreamAdapter(isDirectDeepSeekV4Flash);
export const openCodeDeepSeekV4FlashFreeStreamAdapter = createDeepSeekV4StreamAdapter(
  isOpenCodeDeepSeekV4FlashFree,
  { parserFactory: () => new DeepSeekV4DsmlTextToolParser() },
);
