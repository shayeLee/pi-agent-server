import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CompactionBanner, type CompactionState } from "./CompactionBanner.js";

describe("CompactionBanner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("hides success at 5000ms without renewing on unrelated renders or connection changes", () => {
    const compaction: CompactionState = { status: "succeeded", reason: "manual", requestId: "r1" };
    const { rerender } = render(<CompactionBanner compaction={compaction} />);
    act(() => vi.advanceTimersByTime(3000));
    rerender(<CompactionBanner compaction={compaction} streamLost />);
    act(() => vi.advanceTimersByTime(1999));
    expect(screen.getByRole("status")).toHaveTextContent("上下文已压缩");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CompactionBanner compaction={compaction} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(compaction.status).toBe("succeeded");
  });

  it("renews for a new success object within the same request, even with batched start/end", () => {
    const compaction: CompactionState = { status: "succeeded", reason: "manual", requestId: "r1" };
    const { rerender } = render(<CompactionBanner compaction={compaction} />);
    act(() => vi.advanceTimersByTime(4000));
    rerender(<CompactionBanner compaction={{ ...compaction }} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toBeVisible();
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.getByRole("status")).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CompactionBanner compaction={{ ...compaction }} />);
    expect(screen.getByRole("status")).toBeVisible();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["running", "failed", "aborted", "unknown"] as const)("never auto-hides %s", status => {
    render(<CompactionBanner compaction={{ status, reason: "manual" }} />);
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByRole("status")).toHaveAttribute("data-status", status);
  });

  it("isolates successive rounds, including a new success request, and cleans up on unmount", () => {
    const compaction: CompactionState = { status: "succeeded", reason: "manual", requestId: "r1" };
    const { rerender, unmount } = render(<CompactionBanner compaction={compaction} />);
    act(() => vi.advanceTimersByTime(4000));
    rerender(<CompactionBanner compaction={{ ...compaction, status: "running" }} />);
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole("status")).toHaveTextContent("正在压缩上下文");
    rerender(<CompactionBanner compaction={compaction} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CompactionBanner compaction={{ ...compaction, requestId: "r2" }} />);
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByRole("status")).toHaveTextContent("上下文已压缩");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<CompactionBanner compaction={{ ...compaction, status: "running" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在压缩上下文");
    rerender(<CompactionBanner compaction={compaction} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, null])("hides missing state %s", compaction => {
    const { container } = render(<CompactionBanner compaction={compaction} />);
    expect(container).toBeEmptyDOMElement();
  });
  it.each([
    ["running", "正在压缩上下文…"], ["succeeded", "上下文已压缩"],
    ["failed", "上下文压缩失败"], ["aborted", "上下文压缩已取消"], ["unknown", "压缩状态待确认"],
  ] as const)("renders %s truthfully", (status, label) => {
    const { container } = render(<CompactionBanner compaction={{ status, reason: "manual" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(container.querySelector(".is-running") !== null).toBe(status === "running");
    expect(screen.queryByText(/tokens/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("stops animation on disconnect and follows subsequent props", () => {
    const compaction: CompactionState = { status: "running", reason: "overflow" };
    const { container, rerender } = render(<CompactionBanner compaction={compaction} />);
    rerender(<CompactionBanner compaction={compaction} streamLost />);
    expect(screen.getByRole("status")).toHaveTextContent("压缩状态待确认 / 连接中断");
    expect(container.querySelector(".is-running")).toBeNull();
    rerender(<CompactionBanner compaction={{ ...compaction, status: "aborted" }} streamLost />);
    expect(screen.getByRole("status")).toHaveTextContent("上下文压缩已取消");
  });
  it.each(["manual", "threshold", "overflow"] as const)("describes %s", reason => {
    render(<CompactionBanner compaction={{ status: "unknown", reason }} />);
    expect(screen.getByRole("status").querySelector("[title]")).toHaveAttribute("title", { manual: "手动压缩", threshold: "达到上下文阈值", overflow: "上下文超限" }[reason]);
  });
  it.each([
    [{ tokensBefore: 120000 }, "压缩前 120,000 tokens", "压缩后"],
    [{ tokensAfter: 0 }, "压缩后（估算）0 tokens", "压缩前"],
    [{ tokensBefore: NaN, tokensAfter: Infinity }, "上下文已压缩", "tokens"],
    [{ tokensBefore: -1, tokensAfter: -100 }, "上下文已压缩", "tokens"],
  ])("shows only supplied finite numbers %j", (numbers, text, absent) => {
    render(<CompactionBanner compaction={{ status: "succeeded", reason: "threshold", ...numbers }} />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.getByRole("status")).not.toHaveTextContent(absent);
  });
  it("marks after as estimated without inventing a percentage or summary", () => {
    render(<CompactionBanner compaction={{ status: "succeeded", reason: "manual", tokensBefore: 120000, tokensAfter: 4000, requestId: "hidden-id", willRetry: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("压缩前 120,000 tokens压缩后（估算）4,000 tokens");
    expect(screen.getByRole("status")).not.toHaveTextContent(/%|hidden-id|摘要|重试/);
  });
});
