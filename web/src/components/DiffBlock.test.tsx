import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiffBlock, fragmentDiff } from "./DiffBlock.js";

describe("fragmentDiff pure helper", () => {
  it.each([
    ["keep\nold\n", "keep\nnew\n", ["context", "delete", "add"]],
    ["", "insert\n", ["add"]],
    ["delete\n", "", ["delete"]],
    ["", "", []],
    ["same\n", "same\n", ["context"]],
    ["same", "same\n", ["delete", "add"]],
    ["a\r\n", "a\n", ["delete", "add"]],
  ])("compares %j to %j without inventing file context", (oldText, newText, kinds) => {
    const diff = fragmentDiff(oldText as string, newText as string)!;
    expect(diff.map(line => line.kind)).toEqual(kinds);
    expect(diff.filter(line => line.kind !== "add").map(line => line.text).join("")).toBe(oldText);
    expect(diff.filter(line => line.kind !== "delete").map(line => line.text).join("")).toBe(newText);
  });
  it("bounds both input size and quadratic work", () => {
    expect(fragmentDiff("x".repeat(100_001), "")).toBeNull();
    expect(fragmentDiff("x\n".repeat(501), "y\n".repeat(501))).toBeNull();
  });
});
describe("DiffBlock independent presentation", () => {
  it("shows explicit +/- without newline notices or duplicate originals", () => {
    const oldText = '  <img onerror="alert(1)">\r\nlast';
    const newText = '  const n = 1;\nlast\n';
    const { container } = render(<DiffBlock oldText={oldText} newText={newText} language="ts" />);
    expect(container.querySelector(".diff-delete")?.textContent).toContain("- ");
    expect(container.querySelector(".diff-add")?.textContent).toContain("+ ");
    expect(container).not.toHaveTextContent("末尾无换行");
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.querySelector("details, .code-block, .json-label")).toBeNull();
    expect(container.querySelector(".diff-block")).toHaveAttribute("aria-label", expect.stringContaining("非全文件"));
  });
  it("empty strings keep a semantic marker; large fallback exposes exact originals only in Modal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container, rerender } = render(<DiffBlock oldText="" newText="" />);
    expect(screen.getByText("片段相同（无修改）")).toBeVisible();
    expect(container.querySelectorAll(".code-block pre")).toHaveLength(0);
    const huge = " \r\n" + "x".repeat(100_001);
    const next = "\tchanged\r\n\n";
    rerender(<DiffBlock oldText={huge} newText={next} />);
    expect(container.querySelector('p[role="status"]')).toHaveTextContent("未计算 diff");
    expect(container.querySelector(".diff-lines, details, .code-block")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看原始数据" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(Array.from(container.querySelectorAll(".code-block pre"), el => el.textContent)).toEqual([huge, next]);
    fireEvent.click(screen.getByRole("button", { name: "复制 oldText" }));
    expect(writeText).toHaveBeenLastCalledWith(huge);
    fireEvent.click(screen.getByRole("button", { name: "复制 newText" }));
    expect(writeText).toHaveBeenLastCalledWith(next);
    await screen.findAllByText("已复制");
  });
});
