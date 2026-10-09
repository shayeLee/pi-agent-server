import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThinkingRow } from "./ThinkingRow.js";

describe("ThinkingRow", () => {
  it.each(["", " \n\r\t", "\u00a0\u3000\n"])("hides whitespace %j, live and historical", text => {
    const thinking = { kind: "thinking" as const, id: "empty", text, streaming: true };
    const { container, rerender } = render(<ThinkingRow thinking={thinking} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ThinkingRow thinking={{ ...thinking, streaming: false }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("late text preserves body bytes and manual state without a preview", () => {
    const thinking = { kind: "thinking" as const, id: "late", text: "\n ", streaming: true };
    const { container, rerender } = render(<ThinkingRow thinking={thinking} />);
    expect(container).toBeEmptyDOMElement();
    const text = " \n".repeat(40) + "真实\t思考\n保留  原文\r\n";
    rerender(<ThinkingRow thinking={{ ...thinking, text }} />);
    expect(screen.getByTestId("thinking-body-late").textContent).toBe(text);
    expect(container.querySelector(".thinking-summary")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    rerender(<ThinkingRow thinking={thinking} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ThinkingRow thinking={{ ...thinking, text, streaming: false }} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button"));
    rerender(<ThinkingRow thinking={{ ...thinking, text: text + "结束", streaming: false }} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("thinking-body-late").textContent).toBe(text + "结束");
  });
  it.each([
    [true, "Thinking"],
    [false, "Thought"],
  ])("shows only the %s status title and keeps the full body", (streaming, title) => {
    const text = "第一行\n" + "思考内容".repeat(30);
    const { container } = render(<ThinkingRow thinking={{ kind: "thinking", id: "no-preview", text, streaming }} />);
    const toggle = screen.getByRole("button", { name: "思考过程" });
    expect(toggle).toHaveTextContent(title);
    expect(container.querySelector(".thinking-summary")).toBeNull();
    if (!streaming) fireEvent.click(toggle);
    expect(screen.getByTestId("thinking-body-no-preview").textContent).toBe(text);
  });
  it("流式思考默认展开，但用户可收合；完成后保留用户选择", () => {
    const thinking = { kind: "thinking" as const, id: "t-1", text: "检查调用链", streaming: true };
    const { rerender } = render(<ThinkingRow thinking={thinking} />);
    const toggle = screen.getByRole("button", { name: /思考过程/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.lastElementChild).toHaveClass("thinking-chevron");
    expect(screen.getByTestId("thinking-body-t-1")).toHaveTextContent("检查调用链");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.lastElementChild).toHaveClass("thinking-chevron");
    expect(screen.queryByTestId("thinking-body-t-1")).not.toBeInTheDocument();
    rerender(<ThinkingRow thinking={{ ...thinking, streaming: false }} />);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("thinking-body-t-1")).toHaveTextContent("检查调用链");
  });
});
