import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionConfigBar } from "./SessionConfigBar.js";
import type { ModelInfo, SessionRecord } from "../types.js";

const models: ModelInfo[] = [
  { provider: "deepseek", id: "v4-pro", name: "DeepSeek V4 Pro" },
  { provider: "openai-codex", id: "gpt-5", name: "GPT-5" },
];

const session: SessionRecord = {
  id: "s1",
  ownerKey: "k",
  projectId: "default",
  title: "会话",
  createdAt: 1,
  updatedAt: 1,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null, systemPrompt: null,
};

function setup(partial: Partial<Parameters<typeof SessionConfigBar>[0]> = {}) {
  const props = {
    session,
    models,
    thinkingLevels: ["off", "low", "medium", "high"],
    onChange: vi.fn(),
    ...partial,
  };
  render(<SessionConfigBar {...props} />);
  return props;
}

describe("SessionConfigBar（模型 + 思考级别选择）", () => {
  it("默认显示「服务端默认模型」与「默认思考级别」", () => {
    setup();
    expect((screen.getByTestId("model-select") as HTMLSelectElement).value).toBe("");
    expect((screen.getByTestId("thinking-level-select") as HTMLSelectElement).value).toBe("");
  });

  it("模型选项显示 provider 前缀", () => {
    setup();
    const options = Array.from(screen.getByTestId("model-select").querySelectorAll("option"));
    const optionTexts = options.map((o) => o.textContent);
    expect(optionTexts).toContain("deepseek / DeepSeek V4 Pro");
    expect(optionTexts).toContain("openai-codex / GPT-5");
  });

  it("已配置的模型与思考级别回显", () => {
    setup({
      session: {
        ...session,
        modelProvider: "deepseek",
        modelId: "v4-pro",
        thinkingLevel: "high",
      },
    });
    expect((screen.getByTestId("model-select") as HTMLSelectElement).value).toBe("deepseek/v4-pro");
    expect((screen.getByTestId("thinking-level-select") as HTMLSelectElement).value).toBe("high");
  });

  it("切换模型触发 onChange(modelProvider, modelId)", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByTestId("model-select"), {
      target: { value: "openai-codex/gpt-5" },
    });
    expect(onChange).toHaveBeenCalledWith({ modelProvider: "openai-codex", modelId: "gpt-5" });
  });

  it("切换思考级别触发 onChange(thinkingLevel)", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByTestId("thinking-level-select"), { target: { value: "high" } });
    expect(onChange).toHaveBeenCalledWith({ thinkingLevel: "high" });
  });
});
