import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ToolCall } from "pi-agent-server/client";
import { toolPresentation } from "./presentation.js";
import { toolHeader } from "./metadata.js";
import { rawToolData } from "./raw.js";

const call = (toolName: string, args: unknown): ToolCall => ({ toolCallId: "adapter", toolName, args, done: false, isError: false, result: undefined, partialResult: undefined });
describe("tool presentation contract", () => {
  it("returns separate complete labels, badge and preview without mutating input", () => {
    const tasks = [{ agent: "lite", task: "first" }, { agent: "worker", task: "second", cwd: "/tmp" }];
    const input = call("subagent", { tasks });
    const before = rawToolData(input);
    const header = toolHeader(input);
    expect(header).toEqual({ icon: "agents", badge: "并行 2", priorityLabels: ["lite", "worker"], preview: "first · second", summary: "lite、worker · first · second", target: "lite、worker · first · second" });
    const { Arguments } = toolPresentation(input);
    const { container } = render(<Arguments value={input.args} args={input.args} />);
    expect(container.querySelectorAll(".tool-parallel-tasks > li")).toHaveLength(2);
    expect(screen.getByText("/tmp")).toBeInTheDocument();
    expect(rawToolData(input)).toBe(before);
  });
  it.each([
    { path: "a.ts", edits: [{ oldText: "a", newText: "b" }, null], unknown: false },
    { path: "a.ts", edits: [{ oldText: 0, newText: "b" }], unknown: 0 },
    { path: 42, oldText: "a", newText: "b" },
    { path: "a.ts", edits: [] },
  ])("malformed edit remains fully generic: %j", args => {
    const input = call("edit", args);
    const before = rawToolData(input);
    const { Arguments } = toolPresentation(input);
    const { container } = render(<Arguments value={args} args={args} />);
    expect(container.querySelector(".diff-block")).toBeNull();
    expect(screen.getByText("path", { selector: "dt" })).toBeVisible();
    expect(rawToolData(input)).toBe(before);
  });
  it.each([[], null, [{ agent: " ", task: "x" }], [{ agent: "lite", task: 0 }], [{ agent: "lite", task: "x" }, null]])("invalid tasks %j use safe fields without parallel header", tasks => {
    const input = call("subagent", { tasks });
    const { header, Arguments } = toolPresentation(input);
    expect(header.badge).toBeUndefined();
    const { container } = render(<Arguments value={input.args} args={input.args} />);
    expect(container.querySelector(".tool-parallel-tasks")).toBeNull();
    expect(screen.getByText("tasks")).toBeInTheDocument();
  });
  it("unknown and prototype-like names remain generic; forwards values, labels and raw callback", () => {
    const input = call("constructor", { tasks: [{ agent: "lite", task: "plain" }], zero: 0, flag: false, ids: [0, false, null] });
    const { header, Arguments, Result } = toolPresentation(input);
    expect(header.icon).toBe("tool");
    expect(header.badge).toBeUndefined();
    const onViewRaw = vi.fn();
    const { container } = render(<><Arguments value={input.args} args={input.args} /><Result label="传入标签" value={{ content: [{ type: "image", data: "<script>" }] }} args={input.args} onViewRaw={onViewRaw} /></>);
    expect(container.querySelector(".tool-subagent-task")).toBeNull();
    expect(screen.getByText("[0,false,null]")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "传入标签" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看原始数据" }));
    expect(onViewRaw).toHaveBeenCalledOnce();
  });
  it.each(["read", "write", "edit"])("%s selects file summary and code/diff slots", toolName => {
    const args = { path: "a.ts", content: "const value = 0;", oldText: "old", newText: "new" };
    const { header, Arguments, Result } = toolPresentation(call(toolName, args));
    expect(header.summary).toBe("a.ts");
    const { container } = render(<><Arguments value={args} args={args} /><Result label="结果" value="const value = 0;" args={args} onViewRaw={() => {}} /></>);
    if (toolName === "write") expect(container.querySelector(".code-block")).not.toBeNull();
    if (toolName === "edit") {
      expect(container.querySelector(".diff-lines")).not.toBeNull();
      expect(screen.queryByText("修改前 / 修改后")).not.toBeInTheDocument();
    }
    if (toolName === "read") expect(container.querySelector(".tool-result-text .code-block")?.getAttribute("data-language")).toBe("typescript");
  });
});
