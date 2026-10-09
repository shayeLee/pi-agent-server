import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallCard } from "../components/ToolCallCard.js";
import type { ToolCall } from "pi-agent-server/client";
import { rawToolData } from "./raw.js";
const make = (toolName: string): ToolCall => ({ toolCallId: "file", toolName, args: toolName === "write" ? { path: "a.PY", content: "" } : { path: "a.PY", oldText: "old", newText: "new" }, done: true, isError: false, partialResult: undefined, result: toolName === "write" ? "Successfully wrote to a.PY" : "Successfully replaced 1 block(s) in a.PY." });
function expand(call: ToolCall) { const view = render(<ToolCallCard call={call} />); if (call.done) fireEvent.click(screen.getByRole("button", { name: /工具调用/ })); return view; }
describe("clean file presentation", () => {
  it.each(["edit", "write"])("%s receipt hidden, raw modal and clipboard unchanged", async name => {
    const call = make(name); const raw = rawToolData(call);
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const { container } = expand(call);
    expect(container.textContent).not.toContain("Successfully");
    expect(screen.queryByRole("region", { name: "结果" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Markdown 展示" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "工具更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制原始数据" }));
    expect(copy).toHaveBeenCalledWith(raw);
    fireEvent.click(screen.getByRole("button", { name: "工具更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "查看原始数据" }));
    expect(screen.getByRole("dialog").querySelector("pre")?.textContent).toBe(raw);
  });
  it.each([
    ['write', { content: [{ type: 'text', text: 'Successfully wrote 0 bytes to a.PY' }] }],
    ['edit', { content: [{ type: 'text', text: 'Successfully replaced text in a.PY.' }], details: { diff: '- old\n+ new', firstChangedLine: 1 } }],
  ])('%s standard structured receipt is hidden', (name, result) => {
    const { container } = expand({ ...make(name as string), result });
    expect(container.textContent).not.toContain('Successfully');
    expect(screen.queryByRole('region', { name: '结果' })).toBeNull();
  });
  it.each(["edit", "write"])("%s errors, warnings, structured data and partial remain", name => {
    const call = make(name);
    const { rerender } = expand({ ...call, isError: true });
    expect(screen.getByRole("region", { name: "结果" })).toHaveTextContent("Successfully");
    for (const result of ["Warning: not all bytes written", `${call.result}\nWarning: review permissions`, { content: [{ type: "text", text: call.result }], details: { warning: "review" } }, { warning: "review" }]) {
      rerender(<ToolCallCard call={{ ...call, result }} />);
      expect(screen.getByRole("region", { name: "结果" })).toBeInTheDocument();
    }
    rerender(<ToolCallCard call={{ ...call, done: false, partialResult: call.result }} />);
    expect(screen.getByRole("region", { name: "部分结果" })).toHaveTextContent("Successfully");
  });
  it("write empty content, case-insensitive path language and unknown fields preserved", () => {
    const { container } = expand({ ...make("write"), args: { path: "a.PY", content: "", flag: false, count: 0 } });
    expect(container.querySelector('[data-language="python"] pre')?.textContent).toBe("");
    expect(container.querySelectorAll("dt")).toHaveLength(2);
    expect(screen.getByText("flag")).toBeVisible();
    expect(screen.getByText("false")).toBeVisible();
    expect(screen.getByText("0")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制代码" })).toBeVisible();
  });
  it.each([{ path: "a.py", content: 0 }, { path: 0, content: "x" }])("malformed write stays generic %j", args => {
    const { container } = expand({ ...make("write"), args });
    expect(container.querySelector(".code-block")).toBeNull();
    expect(screen.getByText("path", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("content", { selector: "dt" })).toBeVisible();
  });
});
