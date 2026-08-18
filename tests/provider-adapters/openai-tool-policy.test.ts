import { describe, expect, it } from "vitest";
import { enforceOpenAIToolAvailability } from "../../src/provider-adapters/openai-tool-policy.js";

describe("enforceOpenAIToolAvailability", () => {
  const model = { api: "openai-completions" };

  it("为无工具的 OpenAI-compatible 请求显式声明 tools: [] 与 tool_choice: none", () => {
    expect(enforceOpenAIToolAvailability({ model: "any-openai-compatible-model" }, model)).toEqual({
      model: "any-openai-compatible-model",
      tools: [],
      tool_choice: "none",
    });
  });

  it("保留 Pi 已序列化的工具白名单，并显式声明自动选择", () => {
    const payload = { tools: [{ type: "function", function: { name: "read" } }] };
    expect(enforceOpenAIToolAvailability(payload, model)).toEqual({
      tools: [{ type: "function", function: { name: "read" } }],
      tool_choice: "auto",
    });
  });

  it("不覆盖 Pi 或上游已指定的 tool_choice", () => {
    const payload = { tools: [{ type: "function", function: { name: "read" } }], tool_choice: "required" };
    expect(enforceOpenAIToolAvailability(payload, model)).toBe(payload);
  });

  it("不向非 OpenAI 协议注入不兼容字段，也跳过非对象 payload", () => {
    const anthropic = { api: "anthropic-messages" };
    const payload = { model: "claude" };
    expect(enforceOpenAIToolAvailability(payload, anthropic)).toBe(payload);
    expect(enforceOpenAIToolAvailability("payload", model)).toBe("payload");
  });
});
