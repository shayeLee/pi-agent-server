import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { UsageStats } from "pi-agent-server/client";
import { StatsBar } from "./StatsBar.js";
afterEach(cleanup);
const tokens = { input: 0, output: 42, cacheRead: 0, cacheWrite: 100, totalTokens: 142, costUsdEstimate: 0 };
const stats: UsageStats = { promptTokens: 999, completionTokens: 999, totalTokens: 999, durationMs: 100, ttftMs: 10,
  lastResponse: { ...tokens, ordinal: 1, cacheHitPercent: 0, speed: { outputTokens: 42, generationDurationMs: 10, tokensPerSecond: 4200 } },
  sessionTotals: { ...tokens, scope: "allEntries" }, context: { tokens: null, percent: null, window: 200000, estimate: true } };
it("formats authoritative rich snapshot zeros, cache, cost, speed and nullable context", () => {
  render(<StatsBar stats={stats} timeline={[]} connected />);
  expect(screen.queryByTestId("stat-input")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看统计详情" }));
  expect(screen.getByTestId("stat-input")).toHaveTextContent("输入 0");
  expect(screen.getByTestId("stat-cache-hit")).toHaveTextContent("0 %");
  expect(screen.getByTestId("stat-cost")).toHaveTextContent("估算 0 USD");
  expect(screen.getByTestId("stat-speed")).toHaveTextContent("4200 tok/s");
  expect(screen.getByTestId("stat-session-scope").title).toContain("不另加 subagent ledger");
  expect(screen.queryByTestId("stat-context-tokens")).toBeNull();
  expect(screen.getByTestId("stat-context-window")).toHaveTextContent("20万");
});
it("hides unreliable speed, preserves 100% and explicit null without legacy fallback", () => {
  const view = render(<StatsBar stats={{ ...stats, lastResponse: { ...stats.lastResponse!, cacheHitPercent: 100, speed: { outputTokens: 42, generationDurationMs: 9, tokensPerSecond: null } } }} timeline={[]} connected />);
  fireEvent.click(screen.getByRole("button", { name: "查看统计详情" }));
  expect(screen.queryByTestId("stat-speed")).toBeNull();
  expect(screen.getByTestId("stat-cache-hit")).toHaveTextContent("100 %");
  view.rerender(<StatsBar stats={{ ...stats, lastResponse: null }} timeline={[]} connected />);
  expect(screen.queryByTestId("stat-input")).toBeNull();
});
it("omits empty groups and never substitutes session tokens for an unknown response", () => {
  const view = render(<StatsBar stats={{ ...stats, lastResponse: null, context: { tokens: null, percent: null, window: null, estimate: true } }} timeline={[]} connected />);
  expect(screen.queryByTestId("stat-summary-tokens")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看统计详情" }));
  expect(screen.queryByText(/上下文 · 估算/)).toBeNull();
  expect(screen.getByTestId("stat-session-tokens")).toHaveTextContent("142");
  view.rerender(<StatsBar stats={stats} timeline={[]} connected />);
  expect(screen.getByTestId("stat-input")).toHaveTextContent("输入 0");
  expect(screen.getByTestId("stat-output")).toHaveTextContent("输出 42");
  expect(screen.getByTestId("stat-cache-read")).toHaveTextContent("缓存读 0");
  expect(screen.getByTestId("stat-cache-write")).toHaveTextContent("缓存写 100");
  expect(screen.getByTestId("stat-tokens")).toHaveTextContent("总计 142");
  expect(screen.getByTestId("stat-cost")).toHaveTextContent("0 USD");
});
it("pending snapshots are not live and output speed is hidden", () => {
  render(<StatsBar stats={stats} pending timeline={[]} connected />);
  fireEvent.click(screen.getByRole("button", { name: "查看统计详情" }));
  expect(screen.getByTestId("stat-scope")).toHaveTextContent("上次·非实时");
  expect(screen.queryByTestId("stat-speed")).toBeNull();
});
