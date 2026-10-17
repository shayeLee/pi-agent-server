import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { applySseEvent, createChatState, type ChatState, type SseEvent, type ToolCall } from "pi-agent-server/client";
import { projectExportTimeline } from "../hooks/history-projection.js";
import { ToolCallCard } from "./ToolCallCard.js";

const run = (events: SseEvent[]): ChatState => events.reduce((state, event) => applySseEvent(state, event), createChatState());
const toolCalls = (state: ChatState): ToolCall[] => state.timeline.flatMap(item => item.kind === "tool" ? [item.call] : []);
const errorResult = { content: [{ type: "text", text: "permission denied" }] };

const live: SseEvent[] = [
  { type: "tool_start", toolCallId: "c1", toolName: "codemode", args: { code: "return 1" } },
  { type: "tool_start", toolCallId: "c1/1", toolName: "mcp__docs__search", args: { q: "x" }, parentToolCallId: "c1" },
  { type: "tool_update", toolCallId: "c1/1", toolName: "mcp__docs__search", partialResult: {}, parentToolCallId: "c1" },
  { type: "tool_end", toolCallId: "c1/1", toolName: "mcp__docs__search", result: { content: [] }, isError: false, durationMs: 12, parentToolCallId: "c1" },
  { type: "tool_start", toolCallId: "c1/2", toolName: "mcp__docs__write", args: {}, parentToolCallId: "c1" },
  { type: "tool_end", toolCallId: "c1/2", toolName: "mcp__docs__write", result: errorResult, isError: true, durationMs: 3, parentToolCallId: "c1" },
  { type: "tool_end", toolCallId: "c1", toolName: "codemode", result: { content: [{ type: "text", text: "1" }] }, isError: false, durationMs: 40 },
];

describe("nested tool calls", () => {
  it("fold into the owning card instead of taking their own timeline rows", () => {
    const [call, ...rest] = toolCalls(run(live));
    expect(rest).toEqual([]);
    expect(call).toMatchObject({ toolCallId: "c1", done: true, nested: { complete: true, calls: [
      { id: "c1/1", name: "mcp__docs__search", status: "ok", durationMs: 12, arguments: { q: "x" } },
      { id: "c1/2", name: "mcp__docs__write", status: "error", durationMs: 3, error: "permission denied" },
    ] } });
  });

  it("attribute calls made by nested calls to the same card", () => {
    const [call] = toolCalls(run([
      live[0]!, live[1]!,
      { type: "tool_start", toolCallId: "c1/1/1", toolName: "read", args: {}, parentToolCallId: "c1/1" },
    ]));
    expect(call?.nested?.calls.map(nested => nested.id)).toEqual(["c1/1", "c1/1/1"]);
  });

  it("mark calls still running when the owner ends as unfinished", () => {
    const [call] = toolCalls(run([live[0]!, live[1]!, live[6]!]));
    expect(call?.nested).toEqual({ complete: false, calls: [expect.objectContaining({ id: "c1/1", status: "unfinished" })] });
  });

  it("give an event whose parent has no card its own row", () => {
    expect(toolCalls(run([live[1]!])).map(call => call.toolCallId)).toEqual(["c1/1"]);
  });

  it("render the same list live and after a reload", () => {
    const [liveCall] = toolCalls(run(live));
    const [restored] = projectExportTimeline([
      { type: "tool_call", id: "a", toolCallId: "c1", toolName: "codemode", args: { code: "return 1" }, status: "completed" },
      { type: "tool_result", id: "b", toolCallId: "c1", toolName: "codemode", result: { content: [{ type: "text", text: "1" }] }, isError: false, durationMs: 40,
        nestedCalls: { complete: true, calls: [
          { id: "c1/1", name: "mcp__docs__search", status: "ok", durationMs: 12, arguments: { q: "x" } },
          { id: "c1/2", name: "mcp__docs__write", status: "error", durationMs: 3, arguments: {}, error: "permission denied" },
        ] } },
    ], []);
    const listText = (call: ToolCall) => {
      const { unmount } = render(<ToolCallCard call={call} />);
      fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
      const text = within(screen.getByTestId("nested-tool-calls")).getByRole("list").textContent;
      unmount();
      return text;
    };
    expect(restored?.kind === "tool" && listText(restored.call)).toBe(listText(liveCall!));
  });

  it("show the count in the header and flag an incomplete record", () => {
    render(<ToolCallCard call={{ toolCallId: "c1", toolName: "codemode", args: { code: "return 1" }, partialResult: undefined, result: undefined, isError: false, done: true,
      nested: { complete: false, calls: [{ id: "c1/1", name: "mcp__docs__search", status: "ok", argumentsBytes: 9000 }] } }} />);
    const header = screen.getByRole("button", { name: /工具调用/ });
    expect(header.textContent).toContain("内部调用 1 次");
    fireEvent.click(header);
    expect(screen.getByTestId("codemode-script")).not.toHaveAttribute("open");
    const list = screen.getByTestId("nested-tool-calls");
    expect(list.textContent).toContain("记录不完整");
    expect(list.textContent).toContain("9000 字节");
  });
});
