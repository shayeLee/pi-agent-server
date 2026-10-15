import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TimelineItem } from "pi-agent-server/client";
import { Timeline } from "./Timeline.js";
import { highlightTimelineTarget } from "./step-navigation.js";
import { stepNameColumn } from "./WorkBlock.js";
import type { WorkItem } from "./ledger.js";

const user: TimelineItem = { kind: "message", id: "u", role: "user", text: "跑一下", streaming: false, timestamp: "2026-10-14T05:00:00.000Z" };
const tool = (id: string, done: boolean, isError = false): TimelineItem => ({ kind: "tool", id, call: {
  toolCallId: id, toolName: "bash", args: { command: `echo ${id}` }, partialResult: undefined, result: done ? "ok" : undefined, isError, done } });
const reply: TimelineItem = { kind: "message", id: "a", role: "assistant", text: "完成", streaming: false };

const header = () => screen.getByRole("button", { name: /工作块/ });

describe("Ledger work block (DESIGN.md §4.5)", () => {
  it("expands while a step runs, then folds once the reply follows", () => {
    const { rerender } = render(<Timeline timeline={[user, tool("t1", true), tool("t2", false)]} live />);
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(header()).toHaveTextContent("2 步");
    expect(header()).toHaveTextContent("进行中");
    rerender(<Timeline timeline={[user, tool("t1", true), tool("t2", true, true), reply]} live={false} />);
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(header()).toHaveTextContent("1 失败");
    expect(header()).not.toHaveTextContent("进行中");
  });

  it("keeps a manual choice across later updates", () => {
    const { rerender } = render(<Timeline timeline={[user, tool("t1", false)]} live />);
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "false");
    rerender(<Timeline timeline={[user, tool("t1", false), tool("t2", false)]} live />);
    expect(header()).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps folded steps mounted in order and reveals them for navigation", () => {
    render(<Timeline timeline={[user, tool("t1", true), tool("t2", true), reply]} />);
    expect(header()).toHaveAttribute("aria-expanded", "false");
    const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-timeline-id]")).map(row => row.dataset.timelineId);
    expect(anchors).toEqual(["u", "t1", "t2", "a"]);
    const target = document.querySelector<HTMLElement>('[data-tool-call-id="t2"]')!;
    target.scrollIntoView = () => {};
    act(() => { highlightTimelineTarget(target)(); });
    expect(header()).toHaveAttribute("aria-expanded", "true");
  });

  it("numbers only tool steps and shows recorded time in the gutter", () => {
    const thinking: TimelineItem = { kind: "thinking", id: "k", text: "先看目录", streaming: false };
    render(<Timeline timeline={[user, tool("t1", true), thinking, tool("t2", true), reply]} />);
    fireEvent.click(header());
    expect(Array.from(document.querySelectorAll(".work-steps .step-index")).map(node => node.textContent)).toEqual(["01", "", "02"]);
    const time = document.querySelector(".ledger-entry[data-role='user'] time")!;
    expect(time).toHaveAttribute("dateTime", "2026-10-14T05:00:00.000Z");
    expect(time.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("Ledger observed time", () => {
  it("stamps rows that appear after history settles, but never the settled history itself", () => {
    const untimed: TimelineItem = { kind: "message", id: "old", role: "user", text: "旧消息", streaming: false };
    const { rerender } = render(<Timeline timeline={[untimed]} ready />);
    expect(document.querySelector(".ledger-entry time")).toBeNull();
    // A whole turn can arrive in one batch after `live` already ended.
    rerender(<Timeline timeline={[untimed, tool("t1", true), reply]} ready />);
    const times = document.querySelectorAll(".ledger-entry time");
    expect(times).toHaveLength(1);
    expect(times[0].closest(".ledger-entry")).toHaveAttribute("data-role", "assistant");
  });
});

describe("step name column", () => {
  const named = (id: string, toolName: string) => ({ kind: "tool", id, call: { toolCallId: id, toolName, args: {}, isError: false, done: true } }) as WorkItem;
  const thought = { kind: "thinking", id: "th", text: "plan", streaming: false } as WorkItem;

  it("fits the block's longest tool name instead of a fixed column", () => {
    expect(stepNameColumn([named("a", "bash"), named("b", "subagent_wait")])).toBe(`max(${"subagent_wait".length}ch, 0px)`);
    expect(stepNameColumn([named("a", "bash")])).toBe(`max(${"bash".length}ch, 0px)`);
  });

  it("leaves room for the live thinking label, so the column does not shift when thinking settles", () => {
    expect(stepNameColumn([named("a", "bash"), thought])).toBe(`max(${"bash".length}ch, ${"正在思考".length}em)`);
  });

  it("stops growing for very long names, which wrap inside the column", () => {
    const longest = stepNameColumn([named("a", "unknown_extension_" + "long_tool_name_".repeat(12))]);
    expect(longest).toBe(stepNameColumn([named("a", "x".repeat(200))]));
  });

  it("is applied to the block's steps", () => {
    render(<Timeline timeline={[user, tool("t1", true), reply]} />);
    expect((document.querySelector(".work-steps") as HTMLElement).style.getPropertyValue("--step-name")).toBe(`max(${"bash".length}ch, 0px)`);
  });
});
