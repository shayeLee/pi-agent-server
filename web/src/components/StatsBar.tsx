import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatState, TimelineItem, UsageStats, UsageTokens } from "pi-agent-server/client";
import { cacheShare, rawMetric, validMetric } from "../stats-format.js";
import { formatCompact, formatDuration, formatPercent, formatSpeed, formatTokens, formatUsd } from "../i18n/format.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

/** Context occupancy from which the summary warns (DESIGN.md §3.1). */
export const CONTEXT_WARN_PERCENT = 80;

/**
 * Summary items given up, in this order, while the bar does not fit on one line. The headline usage
 * and the context never drop.
 */
export const SUMMARY_DROP_ORDER = ["tools", "task-tools", "session-cache", "calls", "session-cost", "tasks", "live-speed", "current-call"];

/** `streamLost`: the event stream dropped and is being retried (not merely still connecting). */
export type StatsBarProps = {
  stats: UsageStats | null; streamLost?: boolean; timeline: TimelineItem[]; pending?: boolean;
  modelOutput?: ChatState["modelOutput"]; runProgress?: ChatState["runProgress"]; activeTools?: boolean;
};

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
const tools = (items: TimelineItem[]) => items.filter((item): item is ToolItem => item.kind === "tool");
const count = formatCompact;
/** A zero estimate for a model with traffic means it has no price configured, not that it was free. */
const priced = (tokens: UsageTokens | null | undefined) => validMetric(tokens?.costUsdEstimate) && (tokens.costUsdEstimate > 0 || tokens.totalTokens === 0);
const costText = (tokens: UsageTokens) => priced(tokens) ? formatUsd(tokens.costUsdEstimate!) : validMetric(tokens.costUsdEstimate) ? zhCN.stats.unpriced : null;

/** `alt` is the all-branches value when a section shows both scopes; a missing side shows as `—`. */
type Row = { id: string; label: string; value?: ReactNode; title?: string; alt?: ReactNode; altTitle?: string };
function tokenRows(tokens: UsageTokens | null | undefined, prefix: string): Row[] {
  if (!tokens) return [];
  const rows: Row[] = [];
  if (validMetric(tokens.totalTokens)) rows.push({ id: `${prefix}tokens`, label: zhCN.stats.usage, value: formatTokens(tokens.totalTokens), title: zhCN.units.exactTokens(rawMetric(tokens.totalTokens)) });
  const parts = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite];
  if (parts.every(validMetric)) rows.push({ id: `${prefix}breakdown`, label: zhCN.stats.breakdown, value: zhCN.stats.breakdownValue(...parts.map(n => formatCompact(n!)) as [string, string, string, string]) });
  const share = cacheShare(tokens.input, tokens.cacheRead, tokens.cacheWrite);
  if (share !== null) rows.push({ id: `${prefix}cache-hit`, label: zhCN.stats.cacheHit, value: formatPercent(share) });
  const cost = costText(tokens);
  if (cost) rows.push({ id: `${prefix}cost`, label: zhCN.stats.cost, value: cost, title: validMetric(tokens.costUsdEstimate) ? zhCN.units.exactUsd(rawMetric(tokens.costUsdEstimate)) : undefined });
  return rows;
}

/** Rows of one scope beside the same rows of another, matched by id. */
function pairRows(current: Row[], all: Row[]): Row[] {
  const ids = [...current.map(row => row.id), ...all.map(row => row.id).filter(id => !current.some(row => row.id === id))];
  return ids.map(id => {
    const left = current.find(row => row.id === id);
    const right = all.find(row => row.id === id);
    return { id, label: (left ?? right)!.label, value: left?.value, title: left?.title, alt: right?.value, altTitle: right?.title };
  });
}
const sameTokens = (a: UsageTokens | null | undefined, b: UsageTokens | null | undefined) =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite && a.totalTokens === b.totalTokens && a.costUsdEstimate === b.costUsdEstimate);

function Section({ id, title, hint, rows, columns }: { id: string; title: ReactNode; hint: string; rows: Row[]; columns?: [string, string] }) {
  if (!rows.length) return null;
  return <section className="stats-section" data-testid={`stats-section-${id}`}>
    <h3>{title}<span className="stats-hint" title={hint} aria-label={hint} role="img"><Icon name="info" size={14} /></span></h3>
    <dl data-columns={columns ? "2" : undefined}>
      {columns && <div className="stats-row stats-row-head" aria-hidden="true"><dt /><dd>{columns[0]}</dd><dd>{columns[1]}</dd></div>}
      {rows.map(row => <div key={row.id} className="stats-row" data-testid={`stat-${row.id}`}>
        <dt>{row.label}</dt><dd title={row.title}>{row.value ?? "—"}</dd>
        {columns && <dd title={row.altTitle} data-testid={`stat-${row.id}-all`}>{row.alt ?? "—"}</dd>}
      </div>)}
    </dl>
  </section>;
}

/**
 * Under the Composer (DESIGN.md §3.1): what the session has done, what it has cost, and how full the
 * context is. While a task runs the left and middle groups follow that task instead.
 */
export function StatsBar({ stats, timeline, streamLost = false, pending = false, modelOutput, runProgress, activeTools }: StatsBarProps) {
  const [details, setDetails] = useState(false);
  const summaryRef = useRef<HTMLButtonElement>(null);
  // Drop low-priority items until the line fits; re-run after every render and on resize.
  useLayoutEffect(() => {
    const summary = summaryRef.current;
    if (!summary) return;
    const fit = () => {
      for (const element of summary.querySelectorAll("[data-dropped]")) element.removeAttribute("data-dropped");
      for (const id of SUMMARY_DROP_ORDER) {
        if (summary.scrollWidth <= summary.clientWidth) break;
        const item = summary.querySelector<HTMLElement>(`.stats-item-${id}`);
        if (!item) continue;
        item.setAttribute("data-dropped", "");
        const cluster = item.closest(".stats-cluster");
        if (cluster && !cluster.querySelector(".stats-item:not([data-dropped])")) cluster.setAttribute("data-dropped", "");
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(summary);
    return () => observer.disconnect();
  });
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    setNow(performance.now());
    if (!pending || streamLost || !modelOutput) return;
    const timer = setTimeout(() => setNow(performance.now()), Math.max(0, modelOutput.receivedAt + 2001 - performance.now()));
    return () => clearTimeout(timer);
  }, [pending, streamLost, modelOutput]);
  const active = !streamLost && modelOutput && Math.max(now, performance.now()) - modelOutput.receivedAt < 2000;

  const allTools = tools(timeline);
  let lastUser = timeline.length - 1;
  while (lastUser >= 0 && !(timeline[lastUser]!.kind === "message" && (timeline[lastUser] as { role?: string }).role === "user")) lastUser--;
  const taskTools = tools(timeline.slice(lastUser + 1));
  const toolsRunning = activeTools ?? taskTools.some(item => !item.call.done);
  const execution = stats?.execution;
  const loops = execution?.coverage === "complete" ? execution.totalLoops : execution?.recordedLoops;
  const turns = execution?.coverage === "complete" ? execution.totalTurns : execution?.recordedTurns;
  const partial = execution?.coverage === "recorded" ? zhCN.stats.partial : "";
  const totals = stats?.sessionTotals;
  // The summary follows the conversation on screen: the current branch, else (older servers) the whole file.
  const branchTotals = stats?.branchTotals;
  const shownTotals = branchTotals ?? totals;
  const subagents = stats?.subagentTotals;
  const subagentsAll = stats?.subagentAllTotals;
  const prompt = stats?.currentPrompt;
  const context = stats?.context;
  const speed = modelOutput?.tokensPerSecondEstimate;

  // Left: what was done.
  const activity: { id: string; text: string }[] = [];
  if (pending) {
    if (runProgress) activity.push({ id: "current-call", text: zhCN.stats.currentCall(count(runProgress.calls)) });
    if (taskTools.length) activity.push({ id: "task-tools", text: zhCN.stats.tools(count(taskTools.length)) });
    if (active && validMetric(speed)) activity.push({ id: "live-speed", text: formatSpeed(speed, true) });
  } else {
    if (validMetric(loops)) activity.push({ id: "tasks", text: zhCN.stats.tasks(count(loops)) });
    if (validMetric(turns)) activity.push({ id: "calls", text: zhCN.stats.calls(count(turns)) });
    if (allTools.length) activity.push({ id: "tools", text: zhCN.stats.tools(count(allTools.length)) });
  }
  // Middle: what it cost. Running: this task so far; otherwise the whole session.
  const usage: { id: string; text: string }[] = [];
  if (pending && validMetric(runProgress?.promptTokens)) usage.push({ id: "task-tokens", text: `${zhCN.stats.current} ${formatTokens(runProgress.promptTokens)}` });
  else if (validMetric(shownTotals?.totalTokens)) {
    const share = validMetric(subagents?.totalTokens) && subagents.totalTokens > 0 ? `（${zhCN.stats.subagentShare(formatCompact(subagents.totalTokens))}）` : "";
    usage.push({ id: "session-tokens", text: `${zhCN.stats.session} ${formatTokens(shownTotals.totalTokens)}${share}` });
    const hit = cacheShare(shownTotals.input, shownTotals.cacheRead, shownTotals.cacheWrite);
    if (hit !== null) usage.push({ id: "session-cache", text: `${zhCN.stats.cache} ${formatPercent(hit)}` });
    const cost = priced(shownTotals) ? shownTotals.costUsdEstimate! + (priced(subagents) ? subagents!.costUsdEstimate! : 0) : null;
    if (cost !== null && cost > 0) usage.push({ id: "session-cost", text: formatUsd(cost) });
  }
  // Right: how full the context is.
  // After compaction Pi reports no token count until the next model response (shown as `?`, like Pi).
  const contextUnknown = context?.tokens === null && validMetric(context?.window) && !validMetric(context?.percent);
  const contextText = validMetric(context?.tokens) && validMetric(context?.window)
    ? `${formatCompact(context.tokens)} / ${formatCompact(context.window)}` : validMetric(context?.percent) ? formatPercent(context.percent)
    : contextUnknown ? `? / ${formatCompact(context!.window!)}` : null;
  const nearFull = validMetric(context?.percent) && context.percent >= CONTEXT_WARN_PERCENT;
  const contextTitle = [validMetric(context?.percent) ? `${zhCN.stats.occupied} ${formatPercent(context.percent)}` : "", nearFull ? zhCN.stats.contextNearFull : "",
    contextUnknown ? zhCN.stats.contextUnknown : "", contextText === null ? zhCN.stats.contextUnavailable : ""].filter(Boolean).join("。");

  // Separators come from CSS, so they follow whichever items are still shown.
  const joined = (items: { id: string; text: string }[]) => items.map(item => <span key={item.id} className={`stats-item stats-item-${item.id}`}>
    <span data-testid={`stat-summary-${item.id}`}>{item.text}</span></span>);

  // Details.
  const state = pending ? streamLost ? zhCN.stats.disconnected : active ? zhCN.stats.recentOutput : toolsRunning ? zhCN.stats.toolRunning : zhCN.stats.waiting : null;
  const calls = pending ? runProgress?.calls : prompt?.calls;
  const taskRows: Row[] = [
    ...(state ? [{ id: "task-state", label: zhCN.stats.state, value: state }] : []),
    ...(validMetric(calls) ? [{ id: "task-calls", label: zhCN.stats.modelCalls, value: zhCN.stats.count(count(calls)) }] : []),
    ...(lastUser >= 0 ? [{ id: "task-tools", label: zhCN.stats.toolCalls, value: zhCN.stats.count(count(taskTools.length)) }] : []),
    ...(pending
      ? validMetric(runProgress?.promptTokens) ? [{ id: "task-tokens", label: zhCN.stats.usage, value: formatTokens(runProgress.promptTokens) }] : []
      : tokenRows(prompt, "task-")),
    ...(!pending && validMetric(stats?.durationMs) ? [{ id: "task-duration", label: zhCN.stats.duration, value: formatDuration(stats.durationMs) }] : []),
    ...(!pending && validMetric(stats?.ttftMs) && validMetric(stats?.durationMs) && stats.ttftMs < stats.durationMs
      ? [{ id: "task-ttft", label: zhCN.stats.firstDelta, value: formatDuration(stats.ttftMs) }] : []),
  ];
  const response = stats?.lastResponse;
  const responseSpeed = response?.speed;
  // Older servers send only the three legacy totals.
  const legacy = response === undefined && stats && [stats.promptTokens, stats.completionTokens, stats.totalTokens].some(validMetric)
    ? { input: stats.promptTokens, output: stats.completionTokens, cacheRead: null, cacheWrite: null, totalTokens: stats.totalTokens, costUsdEstimate: null } : null;
  const lastRows: Row[] = [
    ...tokenRows(response ?? legacy, "last-"),
    ...(validMetric(responseSpeed?.tokensPerSecond) ? [{ id: "last-speed", label: zhCN.stats.speed, value: formatSpeed(responseSpeed.tokensPerSecond) }] : []),
  ];
  const userMessages = timeline.filter(item => item.kind === "message" && item.role === "user").length;
  // Task and call counts cover the whole file; the user message count is the loaded (current) branch.
  const executionRows: Row[] = [
    ...(validMetric(loops) ? [{ id: "session-tasks", label: zhCN.stats.taskCount, value: zhCN.stats.count(count(loops)) + partial }] : []),
    ...(validMetric(turns) ? [{ id: "session-calls", label: zhCN.stats.modelCalls, value: zhCN.stats.count(count(turns)) + partial }] : []),
  ];
  const messageRow: Row = { id: "session-messages", label: zhCN.stats.userMessages, value: zhCN.stats.messageCount(count(userMessages)) };
  // Both scopes side by side only when they differ (a session forked in the Pi CLI); otherwise one column.
  const sessionSplit = !!branchTotals && !!totals && !sameTokens(branchTotals, totals);
  const sessionRows: Row[] = sessionSplit
    ? [...executionRows.map(row => ({ ...row, value: undefined, alt: row.value })), messageRow, ...pairRows(tokenRows(branchTotals, "session-"), tokenRows(totals, "session-"))]
    : [...executionRows, messageRow, ...tokenRows(totals, "session-")];
  const subagentScopeRows = (usage: typeof subagents): Row[] => usage ? [
    { id: "subagent-runs", label: zhCN.stats.runs, value: zhCN.stats.runCount(count(usage.runs)) },
    { id: "subagent-calls", label: zhCN.stats.modelCalls, value: zhCN.stats.count(count(usage.calls)) },
    ...tokenRows(usage, "subagent-"),
  ] : [];
  const subagentSplit = subagentsAll !== undefined && !((subagents ?? null) === (subagentsAll ?? null) ||
    (!!subagents && !!subagentsAll && subagents.runs === subagentsAll.runs && subagents.calls === subagentsAll.calls && sameTokens(subagents, subagentsAll)));
  const subagentRows: Row[] = subagentSplit ? pairRows(subagentScopeRows(subagents), subagentScopeRows(subagentsAll)) : subagentScopeRows(subagents);
  const scopes: [string, string] = [zhCN.stats.currentBranch, zhCN.stats.allBranches];
  const byName = new Map<string, number>();
  for (const item of allTools) byName.set(item.call.toolName, (byName.get(item.call.toolName) ?? 0) + 1);
  const failures = allTools.filter(item => item.call.done && item.call.isError).length;
  const toolTime = allTools.reduce((sum, item) => sum + (validMetric(item.call.durationMs) ? item.call.durationMs : 0), 0);
  const toolRows: Row[] = allTools.length ? [
    { id: "tool-count", label: zhCN.stats.toolCalls, value: zhCN.stats.count(count(allTools.length)) },
    ...(failures ? [{ id: "tool-failures", label: zhCN.stats.failures, value: zhCN.stats.count(count(failures)) }] : []),
    ...(toolTime > 0 ? [{ id: "tool-time", label: zhCN.stats.toolTime, value: formatDuration(toolTime) }] : []),
    { id: "tool-distribution", label: zhCN.stats.distribution, value: [...byName].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${count(n)}`).join(" · ") },
  ] : [];
  const contextRows: Row[] = [
    ...(contextText && validMetric(context?.tokens) ? [{ id: "context-used", label: zhCN.stats.used, value: contextText }] : []),
    ...(validMetric(context?.percent) ? [{ id: "context-percent", label: zhCN.stats.occupied, value: formatPercent(context.percent) }] : []),
  ];

  return <><div className="stats-bar" data-testid="stats-bar">
    <button ref={summaryRef} type="button" className="stats-summary" aria-label={zhCN.stats.detailsLabel} aria-haspopup="dialog" data-running={pending ? "true" : undefined} onClick={() => setDetails(true)}>
      {(activity.length > 0 || usage.length > 0) && <span className="stats-group-left">
        {activity.length > 0 && <span className="stats-cluster stats-activity"><Icon name="activity" /><span>{joined(activity)}</span></span>}
        {usage.length > 0 && <span className="stats-cluster stats-usage"><Icon name="tokens" /><span>{joined(usage)}</span></span>}
      </span>}
      {/* Always shown: a missing reading is a placeholder, never a vanished item. */}
      <span className="stats-group-right">
        <span className="stats-cluster stats-context" data-warn={nearFull ? "true" : undefined} data-empty={contextText === null ? "true" : undefined} title={contextTitle || undefined}>
          <Icon name="context" /><span data-testid="stat-summary-context">{zhCN.stats.context} {contextText ?? "—"}</span>
        </span>
      </span>
    </button>
  </div>
  <Modal open={details} onClose={() => setDetails(false)} title={zhCN.stats.details}>
    <div className="stats-detail-content">
      <Section id="task" title={zhCN.stats.currentTask} hint={zhCN.stats.currentTaskHint} rows={taskRows} />
      <Section id="last" title={<>{zhCN.stats.lastCall}{pending && <span className="stats-note">{zhCN.stats.previousRun}</span>}</>} hint={zhCN.stats.lastCallHint} rows={lastRows} />
      <Section id="session" title={zhCN.stats.sessionTotals} hint={zhCN.stats.sessionTotalsHint} rows={sessionRows} columns={sessionSplit ? scopes : undefined} />
      <Section id="subagents" title={zhCN.stats.subagents} hint={zhCN.stats.subagentsHint} rows={subagentRows} columns={subagentSplit ? scopes : undefined} />
      <Section id="tools" title={zhCN.stats.toolsSection} hint={zhCN.stats.toolsHint} rows={toolRows} />
      <Section id="context" title={zhCN.stats.context} hint={zhCN.stats.contextHint} rows={contextRows} />
    </div>
  </Modal></>;
}
