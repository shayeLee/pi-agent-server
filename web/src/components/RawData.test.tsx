import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ToolCallCard, rawToolData } from "./ToolCallCard.js";
import type { ToolCall } from "pi-agent-server/client";
const values = ['  literal\n```json\n{"quote":"\\\""}\n```\n末尾\n', "", { nested: [false, 0, null] }, [0, false, null], null, false, 0, undefined];
const call = (value: unknown): ToolCall => ({ toolCallId: "raw", toolName: "generic", args: value, result: value, done: true, isError: false, partialResult: undefined });
function more() { fireEvent.click(screen.getByRole("button", { name: "工具更多操作" })); }
function view() { more(); fireEvent.click(screen.getByRole("menuitem", { name: "查看原始数据" })); }
function close() { fireEvent.click(screen.getByRole("button", { name: "关闭对话框" })); }
describe("raw modal", () => {
  it.each(values.map((value, index) => ({ value, index })))("complete display and both copy paths #$index", async ({ value }) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ToolCallCard call={call(value)} />);
    more(); fireEvent.click(screen.getByRole("menuitem", { name: "复制原始数据" }));
    await screen.findByText("已复制原始数据");
    expect(writeText).toHaveBeenLastCalledWith(rawToolData(call(value)));
    view();
    const modal = screen.getByRole("dialog", { name: "原始数据 · generic" });
    const source = within(modal).getByLabelText("代码原文");
    expect(source.textContent).toBe(rawToolData(call(value)));
    const parsed = JSON.parse(source.textContent!);
    expect(parsed.argsProvided).toBe(value !== undefined); expect(parsed.resultProvided).toBe(value !== undefined);
    expect(parsed.args).toEqual(value); expect(parsed.result).toEqual(value);
    expect(screen.getByRole("button", { name: /工具调用/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(modal).getByRole("button", { name: "复制原始数据" }));
    await within(modal).findByText("已复制");
    expect(writeText).toHaveBeenLastCalledWith(source.textContent);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(within(modal).getByRole("button", { name: "复制原始数据" }));
    await within(modal).findByText("复制失败，请选择原文复制");
    close(); expect(screen.getByRole("button", { name: "工具更多操作" })).toHaveFocus();
    writeText.mockRejectedValueOnce(new Error("denied"));
    more(); fireEvent.click(screen.getByRole("menuitem", { name: "复制原始数据" }));
    await screen.findByText("复制失败，请查看原始数据并选择原文复制");
  });
  it("menu keyboard and dismissal do not toggle the card", () => {
    render(<ToolCallCard call={call(false)} />);
    const trigger = screen.getByRole("button", { name: "工具更多操作" });
    const header = screen.getByRole("button", { name: /工具调用/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "查看原始数据" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "复制原始数据" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "查看原始数据" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "复制原始数据" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(trigger).toHaveFocus(); expect(screen.queryByRole("menu")).toBeNull();
    more(); fireEvent.pointerDown(document.body); expect(screen.queryByRole("menu")).toBeNull();
    expect(header).toHaveAttribute("aria-expanded", "false");
  });
  it.each([false, true])("snapshot replacement preserves modal and lifecycle, manual=%s", manual => {
    const base = { ...call(0), done: false, result: undefined, partialResult: { content: [{ type: "unknown", data: false }] } };
    const { rerender } = render(<ToolCallCard call={base} />);
    const header = screen.getByRole("button", { name: /工具调用/ });
    if (manual) { fireEvent.click(header); view(); }
    else fireEvent.click(screen.getByRole("button", { name: "查看原始数据" }));
    const modal = screen.getByRole("dialog");
    const raw = () => JSON.parse(within(modal).getByLabelText("代码原文").textContent!);
    expect(raw().partialResult).toEqual(base.partialResult);
    rerender(<ToolCallCard call={{ ...base, partialResult: false }} />);
    expect(raw().partialResult).toBe(false);
    rerender(<ToolCallCard call={{ ...base, done: true, result: null }} />);
    expect(screen.getByRole("dialog")).toBe(modal); expect(modal).toBeVisible();
    expect(raw().result).toBeNull(); expect(raw().resultKind).toBe("final"); expect(raw()).not.toHaveProperty("partialResult");
    expect(header).toHaveAttribute("aria-expanded", "false");
    close(); expect(header).toHaveAttribute("aria-expanded", "false");
  });
});
