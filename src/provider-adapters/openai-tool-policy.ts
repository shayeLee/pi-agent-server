import type { ProviderModelRef, ProviderRequestAdapter } from "./types.js";

const OPENAI_TOOL_CHOICE_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Make tool availability explicit for every OpenAI-compatible model: `none`
 * when no tool is serialized, otherwise `auto` with Pi's exact allowlist. The
 * allowlist itself is never changed. Other provider protocols own their tool
 * serialization and must not receive OpenAI-only `tool_choice` fields.
 */
export function enforceOpenAIToolAvailability(payload: unknown, model: ProviderModelRef): unknown {
  if (!OPENAI_TOOL_CHOICE_APIS.has(String(model?.api)) || !isRecord(payload)) return payload;

  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    return payload.tool_choice === undefined
      ? { ...payload, tool_choice: "auto" }
      : payload;
  }

  return {
    ...payload,
    tools: [],
    tool_choice: "none",
  };
}

/** OpenAI-compatible API 的请求侧工具可用性适配。 */
export const openAIToolPolicyAdapter: ProviderRequestAdapter = {
  id: "openai-tool-policy",
  adaptRequest(payload, model) {
    return OPENAI_TOOL_CHOICE_APIS.has(String(model?.api))
      ? enforceOpenAIToolAvailability(payload, model)
      : undefined;
  },
};
