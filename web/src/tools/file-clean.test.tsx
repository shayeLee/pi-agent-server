import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallCard } from "../components/ToolCallCard.js";
import type { ToolCall } from "pi-agent-server/client";
import { isFileAcknowledgement } from "./file-data.js";
import { toolHeader } from "./metadata.js";
// Exact result from pi-coding-agent 1.1.0 createEditToolDefinition, using in-memory operations.
const batchEdits = Array.from({ length: 5 }, (_, i) => ({ oldText: `old block ${i + 1}`, newText: `new block ${i + 1}` }));
function sdkBatch(path = "docs/testing.md"): ToolCall {
  return {
    toolCallId: "five-blocks", toolName: "edit", args: { path, edits: batchEdits }, done: true, isError: false, partialResult: undefined,
    result: {
      content: [{ type: "text", text: `Successfully replaced 5 block(s) in ${path}.` }],
      details: {
        diff: "-1 old block 1\n-2 old block 2\n-3 old block 3\n-4 old block 4\n-5 old block 5\n+1 new block 1\n+2 new block 2\n+3 new block 3\n+4 new block 4\n+5 new block 5",
        patch: `--- ${path}\n+++ ${path}\n@@ -1,5 +1,5 @@\n-old block 1\n-old block 2\n-old block 3\n-old block 4\n-old block 5\n+new block 1\n+new block 2\n+new block 3\n+new block 4\n+new block 5\n`,
        firstChangedLine: 1,
      },
    },
  };
}
const make = (toolName: string): ToolCall => ({ toolCallId: "file", toolName, args: toolName === "write" ? { path: "a.PY", content: "" } : { path: "a.PY", oldText: "old", newText: "new" }, done: true, isError: false, partialResult: undefined, result: toolName === "write" ? "Successfully wrote to a.PY" : "Successfully replaced 1 block(s) in a.PY." });
function expand(call: ToolCall) { const view = render(<ToolCallCard call={call} />); if (call.done) fireEvent.click(screen.getByRole("button", { name: /工具调用/ })); return view; }
describe("clean file presentation", () => {
  it.each(["docs/testing.md", "docs/a [5]+(test).$^{}|\\file?.md", "docs/中文 testing.md"])("real SDK five-block receipt omitted in collapsed and expanded views: %s", async path => {
    const call = sdkBatch(path);
    const before = structuredClone(call);
    expect(isFileAcknowledgement(call)).toBe(true);
    expect(toolHeader(call).summary).toBe(`${path} · 5 项修改`);
    const { container } = render(<ToolCallCard call={call} />);
    expect(container.textContent).not.toContain("Successfully");
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.queryByRole("region", { name: "结果" })).toBeNull();
    expect(container.textContent).not.toContain("Successfully");
    expect(container.querySelectorAll(".diff-block")).toHaveLength(5);
    for (const edit of batchEdits) {
      expect(container.textContent).toContain(edit.oldText);
      expect(container.textContent).toContain(edit.newText);
    }
    expect(call).toEqual(before);
  });
  it.each(["\n", "\r\n", "\nWarning: review"])("non-single-line receipts remain visible: %j", suffix => {
    const call = sdkBatch();
    const result = `Successfully replaced 5 block(s) in docs/testing.md.${suffix}`;
    expect(isFileAcknowledgement({ ...call, result })).toBe(false);
    const { container } = expand({ ...call, result });
    expect(screen.getByRole("region", { name: "结果" })).toBeInTheDocument();
    expect(container.textContent).toContain("Successfully");
  });
  it("batch string receipt is already recognized, isolating the SDK metadata regression", () => {
    const call = sdkBatch();
    expect(isFileAcknowledgement({ ...call, result: "Successfully replaced 5 block(s) in docs/testing.md." })).toBe(true);
  });
  it("SDK batch errors, partial output, warnings and unknown metadata remain visible", () => {
    const call = sdkBatch();
    const result = call.result as { content: { type: string; text: string }[]; details: Record<string, unknown> };
    const variants: ToolCall[] = [
      { ...call, isError: true },
      { ...call, done: false, result: undefined, partialResult: call.result },
      { ...call, result: { ...result, content: [...result.content, { type: "text", text: "Warning: review changes" }] } },
      { ...call, result: { ...result, content: [{ type: "text", text: `${result.content[0].text}\nWarning: review changes` }] } },
      { ...call, result: { ...result, details: { ...result.details, warning: "review" } } },
      { ...call, result: { ...result, details: { ...result.details, patch: { unknown: true } } } },
      { ...call, result: { ...result, extra: "unknown" } },
      { ...call, result: { content: [{ type: "image", data: "unknown" }] } },
    ];
    const { rerender } = expand(variants[0]);
    for (const variant of variants) {
      expect(isFileAcknowledgement(variant)).toBe(false);
      rerender(<ToolCallCard call={variant} />);
      expect(screen.getByRole("region", { name: variant.done ? "结果" : "部分结果" })).toBeInTheDocument();
    }
    expect(toolHeader(variants[0]).summary).toContain("Successfully");
    expect(toolHeader(variants[1]).summary).toContain("Successfully");
  });
  it.each(["edit", "write"])("%s receipt hidden without mutating result", name => {
    const call = make(name);
    const before = structuredClone(call);
    const { container } = expand(call);
    expect(container.textContent).not.toContain("Successfully");
    expect(screen.queryByRole("region", { name: "结果" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Markdown 展示" })).toBeNull();
    expect(call).toEqual(before);
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
