import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompactionBanner, type CompactionState } from "./CompactionBanner.js";

describe("CompactionBanner", () => {
  it.each([undefined, null])("hides missing state %s", compaction => {
    const { container } = render(<CompactionBanner compaction={compaction} connected />);
    expect(container).toBeEmptyDOMElement();
  });
  it.each([
    ["running", "正在压缩上下文…"], ["succeeded", "上下文已压缩"],
    ["failed", "上下文压缩失败"], ["aborted", "上下文压缩已取消"], ["unknown", "压缩状态待确认"],
  ] as const)("renders %s truthfully", (status, label) => {
    const { container } = render(<CompactionBanner compaction={{ status, reason: "manual" }} connected />);
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(container.querySelector(".is-running") !== null).toBe(status === "running");
    expect(screen.queryByText(/tokens/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("stops animation on disconnect and follows subsequent props", () => {
    const compaction: CompactionState = { status: "running", reason: "overflow" };
    const { container, rerender } = render(<CompactionBanner compaction={compaction} connected />);
    rerender(<CompactionBanner compaction={compaction} connected={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("压缩状态待确认 / 连接中断");
    expect(container.querySelector(".is-running")).toBeNull();
    rerender(<CompactionBanner compaction={{ ...compaction, status: "aborted" }} connected={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("上下文压缩已取消");
  });
  it.each(["manual", "threshold", "overflow"] as const)("describes %s", reason => {
    render(<CompactionBanner compaction={{ status: "unknown", reason }} connected />);
    expect(screen.getByRole("status").querySelector("[title]")).toHaveAttribute("title", { manual: "手动压缩", threshold: "达到上下文阈值", overflow: "上下文超限" }[reason]);
  });
  it.each([
    [{ tokensBefore: 120000 }, "压缩前 120,000 tokens", "压缩后"],
    [{ tokensAfter: 0 }, "压缩后（估算）0 tokens", "压缩前"],
    [{ tokensBefore: NaN, tokensAfter: Infinity }, "上下文已压缩", "tokens"],
    [{ tokensBefore: -1, tokensAfter: -100 }, "上下文已压缩", "tokens"],
  ])("shows only supplied finite numbers %j", (numbers, text, absent) => {
    render(<CompactionBanner compaction={{ status: "succeeded", reason: "threshold", ...numbers }} connected />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.getByRole("status")).not.toHaveTextContent(absent);
  });
  it("marks after as estimated without inventing a percentage or summary", () => {
    render(<CompactionBanner compaction={{ status: "succeeded", reason: "manual", tokensBefore: 120000, tokensAfter: 4000, requestId: "hidden-id", willRetry: true }} connected />);
    expect(screen.getByRole("status")).toHaveTextContent("压缩前 120,000 tokens压缩后（估算）4,000 tokens");
    expect(screen.getByRole("status")).not.toHaveTextContent(/%|hidden-id|摘要|重试/);
  });
});
