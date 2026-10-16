import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatState, TimelineItem, UsageStats, UsageTokens } from "pi-agent-server/client";
import { CONTEXT_WARN_PERCENT, SUMMARY_DROP_ORDER, StatsBar } from "./StatsBar.js";
import { cacheShare } from "../stats-format.js";
import { formatCompact, formatDuration, formatPercent, formatUsd } from "../i18n/format.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const tokens = (total: number, cost: number): UsageTokens => ({ input: total / 4, output: total / 4, cacheRead: total / 2, cacheWrite: 0, totalTokens: total, costUsdEstimate: cost });
const tool = (id: string, toolName: string, extra: Partial<Extract<TimelineItem, { kind: "tool" }>["call"]> = {}): TimelineItem =>
  ({ kind: "tool", id, call: { toolCallId: id, toolName, args: {}, partialResult: null, result: null, isError: false, done: true, ...extra } });
const user = (id: string): TimelineItem => ({ kind: "message", id, role: "user", text: id, streaming: false });
const timeline: TimelineItem[] = [user("u1"), tool("t1", "bash", { durationMs: 1500 }), user("u2"), tool("t2", "read"), tool("t3", "bash", { isError: true, durationMs: 500 })];
const stats: UsageStats = {
  durationMs: 3100, ttftMs: 2400, promptTokens: null, completionTokens: null, totalTokens: null,
  execution: { scope: "allEntries", coverage: "complete", totalLoops: 2, totalTurns: 3, recordedLoops: 2, recordedTurns: 3 },
  lastResponse: { ...tokens(4400, 0.001), ordinal: 2, cacheHitPercent: 50, speed: { outputTokens: 1100, generationDurationMs: 1000, tokensPerSecond: 124 } },
  sessionTotals: { ...tokens(13000, 0.004), scope: "allEntries" },
  currentPrompt: { ...tokens(5200, 0.002), calls: 2 },
  context: { tokens: 4400, window: 1_000_000, percent: 0.44, estimate: true },
};
const summary = () => screen.getByTestId("stats-bar");
const openDetails = () => fireEvent.click(screen.getByRole("button", { name: "查看统计详情" }));

describe("summary bar while idle", () => {
  it("shows session work, session usage and context against its window", () => {
    render(<StatsBar stats={stats} timeline={timeline} />);
    expect(screen.getByTestId("stat-summary-tasks")).toHaveTextContent("2 次任务");
    expect(screen.getByTestId("stat-summary-calls")).toHaveTextContent("3 次调用");
    expect(screen.getByTestId("stat-summary-tools")).toHaveTextContent("工具 3 次");
    expect(screen.getByTestId("stat-summary-session-tokens")).toHaveTextContent(`会话 ${formatCompact(13000)} tok`);
    expect(screen.getByTestId("stat-summary-session-cache")).toHaveTextContent(`缓存 ${formatPercent(cacheShare(3250, 6500, 0)!)}`);
    expect(screen.getByTestId("stat-summary-session-cost")).toHaveTextContent(formatUsd(0.004));
    expect(screen.getByTestId("stat-summary-context")).toHaveTextContent(`上下文 ${formatCompact(4400)} / ${formatCompact(1_000_000)}`);
    // The last call alone is a detail, never the headline number.
    expect(summary()).not.toHaveTextContent(formatCompact(4400) + " tok");
    expect(summary()).not.toHaveTextContent("turn");
  });

  it("names subagent usage beside the session and adds its cost", () => {
    render(<StatsBar stats={{ ...stats, subagentTotals: { ...tokens(8000, 0.003), runs: 2, calls: 5 } }} timeline={timeline} />);
    expect(screen.getByTestId("stat-summary-session-tokens")).toHaveTextContent(`（子代理 ${formatCompact(8000)}）`);
    expect(screen.getByTestId("stat-summary-session-cost")).toHaveTextContent(formatUsd(0.004 + 0.003));
  });

  it("hides the cost of an unpriced model instead of showing zero", () => {
    render(<StatsBar stats={{ ...stats, sessionTotals: { ...tokens(13000, 0), scope: "allEntries" } }} timeline={timeline} />);
    expect(screen.queryByTestId("stat-summary-session-cost")).toBeNull();
    openDetails();
    expect(screen.getByTestId("stat-session-cost")).toHaveTextContent("未计价");
  });

  it("shows an unknown count after compaction against the window, as Pi does", () => {
    render(<StatsBar stats={{ ...stats, context: { tokens: null, window: 1_000_000, percent: null, estimate: true } }} timeline={timeline} />);
    expect(screen.getByTestId("stat-summary-context")).toHaveTextContent(`上下文 ? / ${formatCompact(1_000_000)}`);
    expect(screen.getByTestId("stat-summary-context").parentElement).toHaveAttribute("title", "压缩后的实际占用要等下一次模型回复后才能得知");
  });

  it("warns once the context nears its window", () => {
    const view = render(<StatsBar stats={stats} timeline={timeline} />);
    expect(screen.getByTestId("stat-summary-context").parentElement).not.toHaveAttribute("data-warn");
    view.rerender(<StatsBar stats={{ ...stats, context: { tokens: 900_000, window: 1_000_000, percent: CONTEXT_WARN_PERCENT, estimate: true } }} timeline={timeline} />);
    expect(screen.getByTestId("stat-summary-context").parentElement).toHaveAttribute("data-warn", "true");
  });

  it("omits what is unknown rather than inventing zero", () => {
    const view = render(<StatsBar stats={null} timeline={[]} />);
    expect(view.container.querySelector(".stats-cluster")).toBeNull();
    view.rerender(<StatsBar stats={{ ...stats, execution: null, sessionTotals: null, context: { tokens: null, window: null, percent: 3, estimate: true } }} timeline={[]} />);
    expect(screen.queryByTestId("stat-summary-tasks")).toBeNull();
    expect(screen.queryByTestId("stat-summary-session-tokens")).toBeNull();
    expect(screen.getByTestId("stat-summary-context")).toHaveTextContent(`上下文 ${formatPercent(3)}`);
  });
});

describe("summary bar fitting one line", () => {
  /** Each shown item takes this much room; the bar holds `capacity` of them. */
  const ITEM_WIDTH = 50;
  function layout(capacity: number) {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("stats-summary") ? this.querySelectorAll(".stats-item:not([data-dropped])").length * ITEM_WIDTH : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("stats-summary") ? capacity * ITEM_WIDTH : 0;
    });
    return () => { scroll.mockRestore(); client.mockRestore(); };
  }
  const shown = () => [...document.querySelectorAll(".stats-item:not([data-dropped]) [data-testid]")].map(el => el.getAttribute("data-testid")!.replace("stat-summary-", ""));

  it("drops low-priority items in order until the line fits, keeping usage and context", () => {
    const restore = layout(3);
    render(<StatsBar stats={stats} timeline={timeline} />);
    const all = ["tasks", "calls", "tools", "session-tokens", "session-cache", "session-cost"];
    const dropped = SUMMARY_DROP_ORDER.filter(id => all.includes(id)).slice(0, all.length - 3);
    expect(shown()).toEqual(all.filter(id => !dropped.includes(id)));
    expect(screen.getByTestId("stat-summary-context")).toBeVisible();
    restore();
  });

  it("hides a cluster whose items all dropped", () => {
    const restore = layout(1);
    const view = render(<StatsBar stats={{ ...stats, sessionTotals: { ...tokens(13000, 0), scope: "allEntries" } }} timeline={timeline} />);
    expect(shown()).toEqual(["session-tokens"]);
    expect(view.container.querySelector(".stats-activity")).toHaveAttribute("data-dropped");
    restore();
  });
});

describe("summary bar while a task runs", () => {
  const progress: ChatState["modelOutput"] = { ordinal: 4, phase: "delta", tokensPerSecondEstimate: 124, includesThinking: false, receivedAt: 100 };

  it("follows the task: its call number, its tools, live speed and its tokens so far", () => {
    vi.useFakeTimers();
    let clock = 100; vi.spyOn(performance, "now").mockImplementation(() => clock);
    render(<StatsBar stats={stats} pending timeline={timeline} modelOutput={progress} runProgress={{ calls: 4, promptTokens: 5200 }} />);
    expect(screen.getByTestId("stat-summary-current-call")).toHaveTextContent("本次 第 4 次调用");
    expect(screen.getByTestId("stat-summary-task-tools")).toHaveTextContent("工具 2 次");
    expect(screen.getByTestId("stat-summary-live-speed")).toHaveTextContent("~124 tok/s");
    expect(screen.getByTestId("stat-summary-task-tokens")).toHaveTextContent(`本次 ${formatCompact(5200)} tok`);
    // Speed is shown only while output keeps arriving.
    clock = 2101; act(() => vi.advanceTimersByTime(2001));
    expect(screen.queryByTestId("stat-summary-live-speed")).toBeNull();
  });

  it("keeps the session usage until the task's first call completes, and drops speed on a lost stream", () => {
    render(<StatsBar stats={stats} pending streamLost timeline={timeline} modelOutput={{ ...progress, receivedAt: performance.now() }} runProgress={{ calls: 1, promptTokens: null }} />);
    expect(screen.getByTestId("stat-summary-session-tokens")).toBeInTheDocument();
    expect(screen.queryByTestId("stat-summary-live-speed")).toBeNull();
  });
});

describe("details", () => {
  it("groups each scope as label / value rows", () => {
    render(<StatsBar stats={{ ...stats, subagentTotals: { ...tokens(8000, 0.003), runs: 2, calls: 5 } }} timeline={timeline} />);
    openDetails();
    const task = within(screen.getByTestId("stats-section-task"));
    expect(task.getByTestId("stat-task-calls")).toHaveTextContent("模型调用2 次");
    expect(task.getByTestId("stat-task-tools")).toHaveTextContent("工具调用2 次");
    expect(task.getByTestId("stat-task-tokens")).toHaveTextContent(`用量${formatCompact(5200)} tok`);
    expect(task.getByTestId("stat-task-duration")).toHaveTextContent(formatDuration(3100));
    expect(task.getByTestId("stat-task-ttft")).toHaveTextContent(formatDuration(2400));
    expect(within(screen.getByTestId("stats-section-last")).getByTestId("stat-last-speed")).toHaveTextContent("124 tok/s");
    const session = within(screen.getByTestId("stats-section-session"));
    expect(session.getByTestId("stat-session-tasks")).toHaveTextContent("2 次");
    expect(session.getByTestId("stat-session-messages")).toHaveTextContent("2 条");
    expect(session.getByTestId("stat-session-breakdown")).toHaveTextContent(`缓存读 ${formatCompact(6500)}`);
    expect(within(screen.getByTestId("stats-section-subagents")).getByTestId("stat-subagent-runs")).toHaveTextContent("2 个");
    const tools = within(screen.getByTestId("stats-section-tools"));
    expect(tools.getByTestId("stat-tool-failures")).toHaveTextContent("1 次");
    expect(tools.getByTestId("stat-tool-time")).toHaveTextContent(formatDuration(2000));
    expect(tools.getByTestId("stat-tool-distribution")).toHaveTextContent("bash 2 · read 1");
    expect(within(screen.getByTestId("stats-section-context")).getByTestId("stat-context-percent")).toHaveTextContent(formatPercent(0.44));
  });

  it("explains each scope behind a hint instead of in running text", () => {
    render(<StatsBar stats={stats} timeline={timeline} />);
    openDetails();
    expect(screen.getByRole("img", { name: /不含子代理/ })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/turn_start|allEntries/);
  });

  it("marks partial history and the previous task's last call while running", () => {
    render(<StatsBar stats={{ ...stats, execution: { ...stats.execution!, coverage: "recorded" } }} pending timeline={timeline} runProgress={{ calls: 1, promptTokens: null }} />);
    openDetails();
    expect(screen.getByTestId("stat-session-tasks")).toHaveTextContent("仅含开始记录之后");
    expect(screen.getByTestId("stats-section-last")).toHaveTextContent("（上次任务）");
    expect(screen.getByTestId("stat-task-state")).toHaveTextContent("等待模型输出");
  });
});
