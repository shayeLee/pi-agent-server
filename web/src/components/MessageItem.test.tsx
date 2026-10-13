import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageItem } from "./MessageItem.js";

const cursor = ".ui-icon.streaming-cursor";

describe("MessageItem streaming cursor", () => {
  it.each([true, false].flatMap(streaming => ["", "已收到的文本"].map(text => ({ streaming, text }))))(
    "assistant text=$text streaming=$streaming", ({ text, streaming }) => {
      const { container } = render(<MessageItem item={{ kind: "message", id: "assistant", role: "assistant", text, streaming }} />);
      expect(container.querySelectorAll(cursor)).toHaveLength(streaming ? 1 : 0);
      expect(screen.getByTestId("message-assistant")).toHaveClass("message-row", "row-assistant");
      expect(container.querySelector(".message-assistant > .assistant-content")).toHaveTextContent(text);
    },
  );

  it.each(["", "取消前已收到的文本"])("removes the cursor on cancellation without replacing the row: %j", text => {
    const item = { kind: "message" as const, id: "cancelled", role: "assistant" as const, text, streaming: true };
    const { container, rerender } = render(<MessageItem item={item} />);
    const row = screen.getByTestId("message-cancelled");
    expect(container.querySelectorAll(cursor)).toHaveLength(1);
    rerender(<MessageItem item={{ ...item, streaming: false }} />);
    expect(screen.getByTestId("message-cancelled")).toBe(row);
    expect(container.querySelectorAll(cursor)).toHaveLength(0);
    expect(row).toHaveTextContent(text);
  });

  it.each([true, false].flatMap(streaming => ["", "思考文本"].map(text => ({ streaming, text }))))(
    "thinking text=$text streaming=$streaming", ({ text, streaming }) => {
      const { container } = render(<MessageItem item={{ kind: "thinking", id: "thinking", text, streaming }} />);
      if (text && !streaming) fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
      expect(container.querySelectorAll(cursor)).toHaveLength(text && streaming ? 1 : 0);
      if (!text) expect(container).toBeEmptyDOMElement();
    },
  );

  it("removes the thinking cursor after cancellation even when manually expanded", () => {
    const item = { kind: "thinking" as const, id: "cancelled-thinking", text: "保留思考内容", streaming: true };
    const { container, rerender } = render(<MessageItem item={item} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelectorAll(cursor)).toHaveLength(1);
    rerender(<MessageItem item={{ ...item, streaming: false }} />);
    expect(container.querySelectorAll(cursor)).toHaveLength(0);
    expect(screen.getByRole("button")).toHaveTextContent("思考过程");
    expect(screen.getByTestId("thinking-body-cancelled-thinking")).toHaveTextContent(item.text);
  });
});
