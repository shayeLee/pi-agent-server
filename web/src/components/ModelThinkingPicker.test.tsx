import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelInfo } from "pi-agent-server/client";
import { ModelThinkingPicker } from "./ModelThinkingPicker.js";

const models: ModelInfo[] = [
  { provider: "provider-a", id: "shared-id", name: "Model A" },
  { provider: "provider-b", id: "shared-id", name: "Model B" },
];

function setup(overrides: Partial<Parameters<typeof ModelThinkingPicker>[0]> = {}) {
  const props = {
    models,
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultModel: { provider: "provider-a", id: "shared-id", name: "Model A" },
    defaultThinkingLevel: "medium",
    modelProvider: "provider-b",
    modelId: "shared-id",
    thinkingLevel: "high",
    onConfigChange: vi.fn(),
    ...overrides,
  };
  render(<ModelThinkingPicker {...props} />);
  return props;
}

describe("ModelThinkingPicker", () => {
  it("紧凑显示当前模型和原始思考级别，且 session override 按 provider 与 id 匹配", () => {
    setup();
    expect(screen.getByTestId("model-thinking-trigger")).toHaveTextContent("shared-id");
    expect(screen.getByTestId("model-thinking-trigger")).not.toHaveTextContent("provider-b");
    expect(screen.getByTestId("thinking-trigger")).toHaveTextContent("high");
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));
    expect(screen.getByRole("radio", { name: "provider-b/shared-id (Model B)" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "provider-a/shared-id (Model A)" })).toHaveAttribute("aria-checked", "false");
  });

  it("models 为空时仍包含 defaultModel", () => {
    const { onConfigChange } = setup({
      models: [],
      defaultModel: { provider: "default-provider", id: "default-id", name: "Default Model" },
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
    });
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));
    expect(screen.getByRole("radio", { name: "default-provider/default-id (Default Model)" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    expect(onConfigChange).toHaveBeenCalledWith({ thinkingLevel: "high" });
  });

  it("分别选择模型和思考深度时调用对应配置更新", () => {
    const { onConfigChange } = setup();
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));
    fireEvent.click(screen.getByRole("radio", { name: "provider-a/shared-id (Model A)" }));
    fireEvent.click(screen.getByRole("radio", { name: "low" }));
    expect(onConfigChange).toHaveBeenNthCalledWith(1, { modelProvider: "provider-a", modelId: "shared-id" });
    expect(onConfigChange).toHaveBeenNthCalledWith(2, { thinkingLevel: "low" });
  });

  it("思考档位使用真实原值、保持独立单选组和键盘选择", () => {
    const { onConfigChange } = setup({
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      defaultThinkingLevel: "medium",
      thinkingLevel: "medium",
    });
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));

    const modelOptions = screen.getByRole("radiogroup", { name: "模型" });
    const thinkingOptions = screen.getByRole("radiogroup", { name: "思考深度" });
    expect(modelOptions).toHaveClass("model-thinking-model-options");
    expect(thinkingOptions).toHaveClass("model-thinking-level-options");
    expect(screen.getByRole("radio", { name: "medium" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "xhigh" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("radio", { name: "low" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "medium" })).toHaveFocus();
    expect(onConfigChange).toHaveBeenCalledWith({ thinkingLevel: "medium" });
  });

  it("可按 provider、model ID 或名称搜索，且无匹配时显示空状态", () => {
    setup();
    fireEvent.click(screen.getByTestId("model-thinking-trigger"));
    const search = screen.getByRole("searchbox", { name: "搜索模型" });
    fireEvent.change(search, { target: { value: "provider-b/shared" } });
    expect(screen.getByRole("radio", { name: "provider-b/shared-id (Model B)" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "provider-a/shared-id (Model A)" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "model a" } });
    expect(screen.getByRole("radio", { name: "provider-a/shared-id (Model A)" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的模型")).toBeInTheDocument();
  });

  it.each(["model", "thinking"] as const)("%s 入口同入口切换关闭、不同入口切换焦点且 Escape 回到当前入口", (entry) => {
    const { onConfigChange } = setup();
    const model = screen.getByTestId("model-thinking-trigger");
    const thinking = screen.getByTestId("thinking-trigger");
    const first = entry === "model" ? model : thinking;
    const second = entry === "model" ? thinking : model;
    for (const trigger of [first, second, first]) {
      fireEvent.click(trigger);
      expect(screen.getByRole("dialog", { name: "模型与思考深度" })).toBeInTheDocument();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(trigger === model ? thinking : model).toHaveAttribute("aria-expanded", "false");
      expect(trigger === model ? screen.getByRole("searchbox") : screen.getByRole("radio", { name: "high" })).toHaveFocus();
    }
    expect(onConfigChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(first).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(second);
    fireEvent.click(second);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("非默认 high 初始焦点不触发修改，键盘从 high 移动而非默认第一项", () => {
    const { onConfigChange } = setup();
    fireEvent.click(screen.getByTestId("thinking-trigger"));
    expect(screen.getByRole("radio", { name: "high" })).toHaveFocus();
    expect(onConfigChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "medium" })).toHaveFocus();
    expect(onConfigChange).toHaveBeenCalledExactlyOnceWith({ thinkingLevel: "medium" });
  });

  it("没有匹配思考档位时聚焦第一项但不修改配置", () => {
    const { onConfigChange } = setup({ thinkingLevel: "unknown" });
    fireEvent.click(screen.getByTestId("thinking-trigger"));
    expect(screen.getByRole("radio", { name: "off" })).toHaveFocus();
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("Escape 和点击外部关闭弹层", () => {
    setup();
    const trigger = screen.getByTestId("model-thinking-trigger");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "模型与思考深度" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "模型与思考深度" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "模型与思考深度" })).not.toBeInTheDocument();
  });

  it("deduplicates and sorts supported levels by strength, retaining future levels at the end", () => {
    setup({ thinkingLevels: ["high", "off", "minimal", "low", "medium", "xhigh", "max", "low", "future"], defaultThinkingLevel: "high" });
    fireEvent.click(screen.getByTestId("thinking-trigger"));
    expect(screen.getAllByTestId("model-thinking-level-option").map(option => option.textContent)).toEqual([
      "off", "minimal", "low", "medium", "high", "xhigh", "max", "future",
    ]);
    expect(screen.getByRole("radio", { name: "high" })).toHaveAttribute("aria-checked", "true");
  });

  it("scrolls the current model into its own list without changing selection or moving search focus", () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("model-thinking-model-options") ? { top:100, bottom:200 } as DOMRect
        : this.getAttribute("role") === "radio" && this.getAttribute("aria-checked") === "true"
          ? { top:500, bottom:540, height:40 } as DOMRect : { top:0, bottom:0, height:0 } as DOMRect;
    });
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    try {
      const { onConfigChange } = setup();
      fireEvent.click(screen.getByTestId("model-thinking-trigger"));
      expect(screen.getByRole("radiogroup", { name:"模型" }).scrollTop).toBeGreaterThan(0);
      expect(screen.getByRole("searchbox")).toHaveFocus();
      expect(onConfigChange).not.toHaveBeenCalled();
    } finally { bounds.mockRestore(); height.mockRestore(); }
  });
});
