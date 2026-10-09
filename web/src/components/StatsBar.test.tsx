import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageStats } from "pi-agent-server/client";
import { StatsBar } from "./StatsBar.js";
import { formatDuration, formatTokens } from "../stats-format.js";

afterEach(cleanup);
const full: UsageStats = { promptTokens: 123456, completionTokens: 2345, totalTokens: 125801, durationMs: 12500, ttftMs: 345 };
const show = (stats: Partial<UsageStats> | null, pending = false) => { const view = render(<StatsBar stats={stats as UsageStats | null} pending={pending} connected={false} timeline={[
  { kind: "message", id: "u", role: "user", text: "hi", streaming: false },
  { kind: "tool", id: "t", call: { toolCallId: "t", toolName: "bash", args: {}, result: "ok", partialResult: undefined, done: true, isError: false } },
]} />); fireEvent.click(screen.getByRole("button", { name: "查看统计详情" })); return view; };

describe("StatsBar", () => {
  it("shows source-labelled complete metrics and exact tooltips, never speed/cost", () => {
    show(full);
    expect(screen.queryByTestId("stat-turns")).toBeNull();
    expect(screen.queryByTestId("stat-model-turns")).toBeNull();
    expect(screen.getByText("用户消息 1 条")).toBeVisible();
    expect(screen.getByTestId("stat-steps")).toHaveTextContent("工具 1 次");
    expect(screen.getByTestId("stat-input")).toHaveTextContent("输入 12.3万");
    expect(screen.getByTestId("stat-input").title).toContain("123,456 tokens");
    expect(screen.getByTestId("stat-output")).toHaveTextContent("输出 2345");
    expect(screen.getByTestId("stat-tokens").title).toContain("125,801");
    expect(screen.getByTestId("stat-duration")).toHaveTextContent("请求耗时 12.5 秒");
    expect(screen.getByTestId("stat-duration").title).toContain("12,500 毫秒");
    expect(screen.getByTestId("stat-ttft")).toHaveTextContent("首段延迟 345 毫秒");
    expect(screen.getByTestId("stat-scope").title).toContain("非请求或会话累计");
    expect(screen.getByTestId("stats-bar")).not.toHaveTextContent(/tok\/s|cost|cache|context|LLM/);
  });
  it.each(["complete", "recorded"] as const)("uses authoritative independent counts (%s), explains scope in modal", (coverage) => {
    show({ ...full, execution: { scope: "allEntries", coverage, totalLoops: coverage === "complete" ? 1 : null, totalTurns: coverage === "complete" ? 3 : null, recordedLoops: 1, recordedTurns: 3 } });
    expect(screen.getByTestId("stat-turns")).toHaveTextContent("1 轮");
    expect(screen.getByTestId("stat-model-turns")).toHaveTextContent("3 turn");
    expect(screen.getByTestId("stat-steps")).toHaveTextContent("工具 1 次");
    expect(screen.getByTestId("stat-turns").title).toContain("非用户消息数");
    expect(screen.getByTestId("stats-bar")).not.toHaveTextContent("已记录");
    if (coverage === "recorded") expect(screen.getByText(/已记录范围/)).toBeVisible();
  });
  it("hides the activity cluster for unknown counts and zero tools while keeping details", () => {
    const view = render(<StatsBar stats={null} timeline={[]} connected={false} />);
    expect(screen.queryByTestId("stat-turns")).toBeNull();
    expect(screen.queryByTestId("stat-model-turns")).toBeNull();
    expect(screen.queryByTestId("stat-steps")).toBeNull();
    expect(view.container.querySelector(".stats-cluster")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看统计详情" }));
    expect(screen.getByText(/未知 轮 · 未知 turn/)).toBeVisible();
    expect(screen.getByText("0 次工具调用")).toBeVisible();
  });
  it("shows known loops independently when turns are missing", () => {
    render(<StatsBar stats={{ ...full, execution: { scope: "allEntries", coverage: "recorded", totalLoops: null, totalTurns: null, recordedLoops: 2, recordedTurns: null } }} timeline={[]} connected={false} />);
    expect(screen.getByTestId("stat-turns")).toHaveTextContent("2 轮");
    expect(screen.queryByTestId("stat-model-turns")).toBeNull();
    expect(screen.queryByTestId("stat-steps")).toBeNull();
  });
  it("shows only explicit positive tool counts without guessing", () => {
    show(full);
    expect(screen.getByTestId("stat-steps")).toHaveTextContent("工具 1 次");
  });
  it("shows speed alone without leading or repeated separators", () => {
    render(<StatsBar stats={{ ...full, lastResponse: { input: null, output: 1, cacheRead: null, cacheWrite: null, totalTokens: null, costUsdEstimate: null, ordinal: 1, cacheHitPercent: null, speed: { outputTokens: 1, generationDurationMs: 10, tokensPerSecond: 42 } } }} timeline={[]} connected />);
    expect(screen.getByTestId("stat-summary-speed")).toHaveTextContent("42 tok/s");
    expect(screen.queryByTestId("stat-turns")).toBeNull();
    const cluster = screen.getByTestId("stat-summary-speed").closest(".stats-cluster");
    expect(cluster).toHaveTextContent("42 tok/s");
    expect(cluster).not.toHaveTextContent(/^ ·|· ·/);
  });
  it("shows genuine current-session zero counts", () => {
    show({ ...full, execution: { scope: "allEntries", coverage: "complete", totalLoops: 0, totalTurns: 0, recordedLoops: 0, recordedTurns: 0 } });
    expect(screen.getByTestId("stat-turns")).toHaveTextContent("0 轮");
    expect(screen.getByTestId("stat-model-turns")).toHaveTextContent("0 turn");
  });
  it("shows measured token zeros as zero", () => {
    show({ promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, ttftMs: 0 });
    expect(screen.getByTestId("stat-output")).toHaveTextContent("输出 0");
    expect(screen.getByTestId("stat-duration")).toHaveTextContent("0 毫秒");
    expect(screen.queryByTestId("stat-ttft")).toBeNull();
    expect(screen.getByTestId("stat-scope").title).toContain("已测零显示 0");
  });
  it.each([null, {}, { promptTokens: null, completionTokens: undefined, totalTokens: NaN, durationMs: Infinity, ttftMs: -1 }])("omits unavailable/invalid values: %j", (stats) => {
    show(stats as Partial<UsageStats> | null);
    expect(screen.queryByTestId("stat-scope")).toBeNull();
    expect(screen.getByTestId("stat-steps")).toBeVisible();
  });
  it("shows partial data independently", () => {
    show({ completionTokens: 42, durationMs: 900 });
    expect(screen.getByTestId("stat-output")).toHaveTextContent("42");
    expect(screen.queryByTestId("stat-input")).toBeNull();
    expect(screen.queryByTestId("stat-tokens")).toBeNull();
  });
  it("labels retained stats non-realtime while queued/streaming; never invents usage", () => {
    const view = show(full, true);
    expect(screen.getByTestId("stat-scope")).toHaveTextContent("上次·非实时");
    view.rerender(<StatsBar stats={null} pending connected timeline={[]} />);
    expect(screen.queryByTestId("stat-scope")).toBeNull();
  });
  it("omits ambiguous no-delta timing", () => {
    show({ durationMs: 900, ttftMs: 900 });
    expect(screen.queryByTestId("stat-ttft")).toBeNull();
  });
  it("formats compact tokens and subsecond/second durations in Chinese", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(10000)).toBe("1万");
    expect(formatDuration(0)).toBe("0 毫秒");
    expect(formatDuration(999)).toBe("999 毫秒");
    expect(formatDuration(1000)).toBe("1 秒");
    expect(formatDuration(1234)).toBe("1.2 秒");
  });
});
