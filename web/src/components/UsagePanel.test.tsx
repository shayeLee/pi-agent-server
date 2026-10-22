import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ModelUsage, UsagePeriod, UsageReport, UsageTotals } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { axisScale, useUsagePanel } from "./UsagePanel.js";

const text = zhCN.usage;
const totals = (totalTokens: number, cost = 0): UsageTotals =>
  ({ input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, costUsdEstimate: cost, calls: 1, subagentTokens: 0 });
const model = (name: string, tokens: number, cost = 0): ModelUsage => ({ provider: "p", model: name, ...totals(tokens, cost) });

function report(period: UsagePeriod, models: ModelUsage[]): UsageReport {
  const sum = models.reduce((t, m) => ({ ...t, totalTokens: t.totalTokens + m.totalTokens, input: t.input + m.input, costUsdEstimate: t.costUsdEstimate + m.costUsdEstimate, calls: t.calls + 1 }), totals(0));
  return { period, timeZone: "UTC", from: "2026-10-20", to: "2026-10-21", sessions: 3, unreadSessions: 1, models, totals: { ...sum, calls: models.length },
    buckets: [{ start: "2026-10-20", totals: totals(0), models: [] }, { start: "2026-10-21", totals: { ...sum, calls: models.length }, models }] };
}

function Entry({ api }: { api: Parameters<typeof useUsagePanel>[0]["api"] }) {
  const entry = useUsagePanel({ api });
  return <><button type="button" data-testid="usage-open" onClick={entry.openPanel}>open</button>{entry.dialog}</>;
}

async function open(getUsage: Parameters<typeof useUsagePanel>[0]["api"]["getUsage"]) {
  render(<Entry api={{ getUsage }} />);
  fireEvent.click(screen.getByTestId("usage-open"));
  return within(await screen.findByTestId("usage-panel"));
}

describe("UsagePanel", () => {
  it("asks only when opened, then shows totals, unread files and one row per model", async () => {
    const getUsage = vi.fn(async ({ period }: { period: UsagePeriod }) => report(period, [model("a", 300, 1.5), model("b", 100)]));
    render(<Entry api={{ getUsage }} />);
    expect(getUsage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("usage-open"));
    const panel = within(await screen.findByTestId("usage-panel"));
    await panel.findByTestId("usage-table");
    expect(getUsage).toHaveBeenCalledWith({ period: "day", timeZone: expect.any(String) });
    expect(panel.getByText(text.unread(1))).toBeTruthy();
    const rows = within(panel.getByTestId("usage-table")).getAllByRole("row").map(row => row.textContent);
    expect(rows.slice(1, 3).map(row => row!.slice(0, 3))).toEqual(["p/a", "p/b"]);
  });

  it("switches period and narrows the table to a clicked bar", async () => {
    const getUsage = vi.fn(async ({ period }: { period: UsagePeriod }) => report(period, [model("a", 300)]));
    const panel = await open(getUsage);
    await panel.findByTestId("usage-chart");
    fireEvent.click(panel.getByRole("radio", { name: text.periods.month }));
    await waitFor(() => expect(getUsage).toHaveBeenLastCalledWith({ period: "month", timeZone: expect.any(String) }));
    const bars = await waitFor(() => { const found = panel.getByTestId("usage-chart").querySelectorAll<HTMLButtonElement>(".usage-bar"); expect(found).toHaveLength(2); return found; });
    fireEvent.click(bars[1]!);
    expect(bars[1]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(panel.getByTestId("usage-show-all"));
    expect(panel.queryByTestId("usage-show-all")).toBeNull();
  });

  it("folds models past the fifth into one series and keeps them in the table", async () => {
    const models = ["a", "b", "c", "d", "e", "f"].map((name, i) => model(name, 600 - i * 100));
    const panel = await open(vi.fn(async () => report("day", models)));
    const legend = await panel.findByTestId("usage-legend");
    expect(within(legend).getAllByRole("listitem").map(item => item.textContent)).toEqual(["p/a", "p/b", "p/c", "p/d", text.other]);
    expect(within(panel.getByTestId("usage-table")).getByText("p/f")).toBeTruthy();
  });

  it("says when the range has no calls, and offers a retry after a failure", async () => {
    const getUsage = vi.fn().mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValue(report("day", []));
    const panel = await open(getUsage);
    fireEvent.click(await panel.findByRole("button", { name: text.retry }));
    expect(await panel.findByText(text.empty)).toBeTruthy();
  });
});

describe("axisScale", () => {
  it("rounds the top to 1, 2 or 5 steps", () => {
    expect(axisScale(340_000_000)).toEqual({ top: 400_000_000, step: 200_000_000 });
    expect(axisScale(7)).toEqual({ top: 10, step: 5 });
    expect(axisScale(0)).toEqual({ top: 1, step: 1 / 3 });
  });
});
