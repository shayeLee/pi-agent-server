import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCallCard } from "./ToolCallCard.js";
import type { ToolCall } from "../types.js";

function card(partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: "t1",
    toolName: "search",
    args: { q: "x" },
    partialResult: undefined,
    result: undefined,
    isError: false,
    done: false,
    ...partial,
  };
}

describe("ToolCallCard（工具调用流式卡片）", () => {
  it("tool_start 状态：显示工具名与 args，无完成标记", () => {
    render(<ToolCallCard call={card()} />);
    expect(screen.getByTestId("tool-name")).toHaveTextContent("search");
    expect(screen.getByTestId("tool-args")).toHaveTextContent('{"q":"x"}');
    expect(screen.queryByTestId("tool-done")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-partial")).not.toBeInTheDocument();
  });

  it("tool_update 状态：展示流式 partialResult 内容", () => {
    render(<ToolCallCard call={card({ partialResult: "部" })} />);
    expect(screen.getByTestId("tool-partial")).toHaveTextContent("部");
    expect(screen.queryByTestId("tool-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-done")).not.toBeInTheDocument();
  });

  it("tool_end 状态：标记完成并展示 result，partialResult 让位于 result", () => {
    render(
      <ToolCallCard call={card({ partialResult: "部", result: "完整结果", done: true })} />,
    );
    expect(screen.getByTestId("tool-done")).toBeInTheDocument();
    expect(screen.getByTestId("tool-result")).toHaveTextContent("完整结果");
    expect(screen.queryByTestId("tool-partial")).not.toBeInTheDocument();
  });

  it("tool_end 带 isError：展示失败标记", () => {
    render(<ToolCallCard call={card({ result: "rate limit", isError: true, done: true })} />);
    expect(screen.getByTestId("tool-error")).toBeInTheDocument();
    expect(screen.getByTestId("tool-done")).toBeInTheDocument();
  });

  it("卡片是可折叠的 details 结构", () => {
    render(<ToolCallCard call={card({ partialResult: "x" })} />);
    expect(screen.getByTestId("tool-call-card").tagName).toBe("DETAILS");
  });
});