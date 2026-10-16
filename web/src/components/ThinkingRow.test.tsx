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
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button"));
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
    [true, "正在思考"],
    [false, "思考"],
  ])("shows the %s status title, a collapsed-only preview, and keeps the full body", (streaming, title) => {
    const text = "第一行\n" + "思考内容".repeat(30);
    const { container } = render(<ThinkingRow thinking={{ kind: "thinking", id: "no-preview", text, streaming }} />);
    const toggle = screen.getByRole("button", { name: "思考过程" });
    expect(toggle).toHaveTextContent(title);
    expect(toggle).toHaveAttribute("title", "展开思考过程");
    expect(container.querySelector(".thinking-summary")).toBeNull();
    // Ledger (DESIGN.md §4.4): collapsed rows show a whitespace-normalised 60-char preview.
    expect(container.querySelector(".thinking-preview")?.textContent).toBe(`第一行 ${"思考内容".repeat(30)}`.slice(0, 60) + "…");
    fireEvent.click(toggle);
    expect(container.querySelector(".thinking-preview")).toBeNull();
    expect(toggle).toHaveAttribute("title", "收起思考过程");
    expect(screen.getByTestId("thinking-body-no-preview").textContent).toBe(text);
  });
  it("流式与完成后的思考都默认收起，用户展开后保留选择", () => {
    const thinking = { kind: "thinking" as const, id: "t-1", text: "检查调用链", streaming: true };
    const { rerender } = render(<ThinkingRow thinking={thinking} />);
    const toggle = screen.getByRole("button", { name: /思考过程/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.lastElementChild).toHaveClass("thinking-chevron");
    expect(screen.queryByTestId("thinking-body-t-1")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("thinking-body-t-1")).toHaveTextContent("检查调用链");
    rerender(<ThinkingRow thinking={{ ...thinking, streaming: false }} />);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("thinking-body-t-1")).not.toBeInTheDocument();
  });
});
