import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ToolCall } from "pi-agent-server/client";
import { ToolCallCard } from "./ToolCallCard.js";
import { formatToolDuration } from "../tools/duration.js";
const base: ToolCall = { toolCallId: "duration", toolName: "subagent_wait", args: { runIds: ["fixture"] }, partialResult: "waiting", result: "still running", done: true, isError: false };
describe("SDK tool duration", () => {
  it.each([[0, "0ms"], [0.00001, "<1ms"], [1.23, "1ms"], [999.99, "999ms"], [1000, "1s"], [1234.56789, "1.2s"], [59999, "1m"], [60000, "1m"], [61500, "1m 1.5s"], [3599999, "60m"]] as const)("formats %s as %s", (value, text) => expect(formatToolDuration(value)).toBe(text));
  it.each([undefined, null, NaN, -1, Infinity, -Infinity])("hides unavailable %s", durationMs => {
    const { container } = render(<ToolCallCard call={{ ...base, durationMs }} />);
    expect(container.querySelector(".tool-duration")).toBeNull();
  });
  it("preserves zero and full title precision; old records remain absent", () => {
    const { rerender } = render(<ToolCallCard call={{ ...base, durationMs: 0 }} />);
    expect(screen.getByText("0ms")).toHaveAttribute("title", "工具调用耗时：0 ms（本次 wait 调用，非子 agent 运行时长）");
    const call = { ...base, durationMs: 1234.56789 };
    rerender(<ToolCallCard call={call} />);
    expect(screen.getByText("1.2s").title).toContain("1234.56789 ms");
  });
  it.each([true, false])("keeps manual expanded=%s through final update", expanded => {
    const { rerender, container } = render(<ToolCallCard call={{ ...base, done: false, durationMs: 12 }} />);
    const header = screen.getByRole("button", { name: /工具调用/ });
    expect(container.querySelector(".tool-duration")).toBeNull();
    fireEvent.click(header);
    if (expanded) fireEvent.click(header);
    rerender(<ToolCallCard call={{ ...base, durationMs: 61500, isError: true }} />);
    expect(header).toHaveAttribute("aria-expanded", String(expanded));
    expect(container.querySelector('.tool-call-body') !== null).toBe(expanded);
    expect(screen.getByText("1m 1.5s")).toBeInTheDocument();
  });
});
