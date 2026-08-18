import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  it("tool_start 状态：显示工具名与运行中标记，默认折叠不显示参数", () => {
    render(<ToolCallCard call={card()} />);
    expect(screen.getByTestId("tool-name")).toHaveTextContent("search");
    expect(screen.getByTestId("tool-call-card").dataset.done).toBe("false");
    // 默认折叠：args 不在 DOM
    expect(screen.queryByText("参数")).not.toBeInTheDocument();
  });

  it("点击头部展开显示参数 JSON", () => {
    render(<ToolCallCard call={card()} />);
    fireEvent.click(screen.getByTestId("tool-call-card").querySelector("button")!);
    expect(screen.getByText("参数")).toBeInTheDocument();
    expect(screen.getByText(/"q": "x"/)).toBeInTheDocument();
  });

  it("tool_update 状态：展开后展示流式 partialResult", () => {
    render(<ToolCallCard call={card({ partialResult: "部" })} />);
    fireEvent.click(screen.getByTestId("tool-call-card").querySelector("button")!);
    expect(screen.getByText("部分结果")).toBeInTheDocument();
    expect(screen.getByText("部")).toBeInTheDocument();
    expect(screen.queryByText("结果")).not.toBeInTheDocument();
  });

  it("tool_end 状态：标记完成并展示 result，partialResult 让位于 result", () => {
    render(<ToolCallCard call={card({ partialResult: "部", result: "完整结果", done: true })} />);
    expect(screen.getByTestId("tool-call-card").dataset.done).toBe("true");
    fireEvent.click(screen.getByTestId("tool-call-card").querySelector("button")!);
    expect(screen.getByText("结果")).toBeInTheDocument();
    expect(screen.getByText("完整结果")).toBeInTheDocument();
    expect(screen.queryByText("部分结果")).not.toBeInTheDocument();
  });

  it("tool_end 带 isError：展示失败标记", () => {
    render(<ToolCallCard call={card({ result: "rate limit", isError: true, done: true })} />);
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByTestId("tool-call-card").dataset.done).toBe("true");
  });
});
