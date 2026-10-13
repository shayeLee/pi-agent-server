import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ChatState, TimelineItem, UsageStats, UsageTokens } from "pi-agent-server/client";
import { formatDuration, formatTokens, rawMetric, validMetric } from "../stats-format.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
const compact = (value: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(value);

export type StatsBarProps = { stats: UsageStats | null; connected: boolean; timeline: TimelineItem[]; pending?: boolean; modelOutput?: ChatState["modelOutput"]; activeTools?: boolean };
type Metric = { id: string; label: string; value: unknown; unit?: string };
const tokenMetrics = (tokens: UsageTokens, prefix = ""): Metric[] => [
  { id: `${prefix}input`, label: zhCN.stats.input, value: tokens.input },
  { id: `${prefix}output`, label: zhCN.stats.output, value: tokens.output },
  { id: `${prefix}cache-read`, label: zhCN.stats.cacheRead, value: tokens.cacheRead },
  { id: `${prefix}cache-write`, label: zhCN.stats.cacheWrite, value: tokens.cacheWrite },
  { id: `${prefix}tokens`, label: zhCN.stats.total, value: tokens.totalTokens },
  { id: `${prefix}cost`, label: zhCN.stats.costEstimate, value: tokens.costUsdEstimate, unit: "USD" },
];
function Metrics({ metrics, source }: { metrics: Metric[]; source: string }) {
  return metrics.filter(m => validMetric(m.value)).map(({ id, label, value, unit }) => {
    const n = value as number;
    const formatted = unit === zhCN.stats.milliseconds ? formatDuration(n) : unit === "USD" ? `${n === 0 ? "0" : n < 0.001 ? n.toPrecision(2) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 })} USD` : `${formatTokens(n)}${unit ? ` ${unit}` : ""}`;
    return <span key={id} className="stat-item" data-testid={`stat-${id}`} title={`${label}：${rawMetric(n)} ${unit ?? "tokens"}。${source}`}>
      {label} {formatted}
    </span>;
  });
}
export function StatsBar({ stats, timeline, connected, pending = false, modelOutput, activeTools }: StatsBarProps) {
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    setNow(performance.now());
    if (!pending || !connected || !modelOutput) return;
    const timer = setTimeout(() => setNow(performance.now()), Math.max(0, modelOutput.receivedAt + 2001 - performance.now()));
    return () => clearTimeout(timer);
  }, [pending, connected, modelOutput]);
  const active = connected && modelOutput && Math.max(now, performance.now()) - modelOutput.receivedAt < 2000;
  const tools = activeTools ?? timeline.some(item => item.kind === "tool" && !item.call.done);
  const liveLabel = !connected ? zhCN.stats.disconnected : active ? zhCN.stats.recentOutput : tools ? zhCN.stats.toolRunning : zhCN.stats.waiting;
  const response = stats?.lastResponse;
  const last: Metric[] = stats ? response ? [
    ...tokenMetrics(response),
    { id: "cache-hit", label: zhCN.stats.cacheHit, value: response.cacheHitPercent, unit: "%" },
    { id: "speed", label: zhCN.stats.speed, value: !pending && validMetric(response.speed?.generationDurationMs) && response.speed.generationDurationMs >= 10 ? response.speed.tokensPerSecond : null, unit: "tok/s" },
  ] : stats.lastResponse === undefined ? [
    { id: "input", label: zhCN.stats.input, value: stats.promptTokens },
    { id: "output", label: zhCN.stats.output, value: stats.completionTokens },
    { id: "tokens", label: zhCN.stats.total, value: stats.totalTokens },
  ] : [] : [];
  if (stats) last.push(
    { id: "duration", label: zhCN.stats.requestDuration, value: stats.durationMs, unit: zhCN.stats.milliseconds },
    { id: "ttft", label: zhCN.stats.firstDelta, value: validMetric(stats.durationMs) && stats.ttftMs < stats.durationMs ? stats.ttftMs : null, unit: zhCN.stats.milliseconds },
  );
  const execution = stats?.execution;
  const loops = execution?.coverage === "complete" ? execution.totalLoops : execution?.recordedLoops;
  const turns = execution?.coverage === "complete" ? execution.totalTurns : execution?.recordedTurns;
  const executionSource = zhCN.stats.executionScope;
  const totals = stats?.sessionTotals;
  const context = stats?.context;
  const source = zhCN.stats.lastResponseScope;
  const total = response?.totalTokens;
  const speed = last.find(m => m.id === "speed")?.value;
  const toolCount = timeline.filter(i => i.kind === "tool").length;
  const liveSource = zhCN.stats.activityScope(liveLabel);
  const activityMetrics: { id: string; content: ReactNode }[] = [];
  if (validMetric(loops)) activityMetrics.push({ id: "loops", content: <span data-testid="stat-turns" title={executionSource}>{compact(loops)}  {zhCN.stats.roundUnit}</span> });
  if (validMetric(turns)) activityMetrics.push({ id: "turns", content: <span data-testid="stat-model-turns" title={executionSource}>{compact(turns)} turn</span> });
  if (validMetric(toolCount) && toolCount > 0) activityMetrics.push({ id: "tools", content: <span data-testid="stat-steps" title={zhCN.stats.toolCountScope}>{zhCN.errors.toolFallback} {compact(toolCount)}  {zhCN.stats.toolUnit}</span> });
  if (pending && active && validMetric(modelOutput?.tokensPerSecondEstimate)) activityMetrics.push({ id: "live-speed", content: <span data-testid="stat-live-speed" title={liveSource}>~{compact(modelOutput.tokensPerSecondEstimate)} tok/s</span> });
  else if (!pending && validMetric(speed)) activityMetrics.push({ id: "speed", content: <span data-testid="stat-summary-speed" title={source}>{compact(speed)} tok/s</span> });
  const contextMetrics: Metric[] = context ? [
    { id: "context-percent", label: zhCN.stats.occupied, value: context.percent, unit: "%" },
    { id: "context-tokens", label: "tokens", value: context.tokens },
    { id: "context-window", label: zhCN.stats.window, value: context.window },
  ] : [];
  const hasLeft = activityMetrics.length > 0 || validMetric(total);
  const hasRight = validMetric(context?.percent);
  return <><div className="stats-bar" data-testid="stats-bar">
    <button type="button" className="stats-summary" aria-label={zhCN.stats.detailsLabel} aria-haspopup="dialog" onClick={() => setDetails(true)}>
      {hasLeft && <span className="stats-group-left">
        {activityMetrics.length > 0 && <span className="stats-cluster">
          <Icon name="activity" />
          {activityMetrics.map((metric, index) => <span key={metric.id}>{index > 0 && " · "}{metric.content}</span>)}
        </span>}
        {validMetric(total) && <span className="stats-cluster" title={zhCN.stats.totalTokensHint(rawMetric(total), source, pending ? zhCN.stats.previousSnapshot : "")}><Icon name="tokens" /><span data-testid="stat-summary-tokens">{compact(total)} tok</span>
          {validMetric(response?.cacheHitPercent) && <span className="stats-cache" title={zhCN.stats.cacheHitHint(rawMetric(response!.cacheHitPercent!))}>{zhCN.stats.cacheHitLabel} {compact(response!.cacheHitPercent!)}%</span>}
        </span>}
      </span>}
      {hasRight && <span className="stats-group-right">
        <span className="stats-cluster" title={zhCN.stats.contextHint(rawMetric(context!.percent!))}>
          <Icon name="context" />
          <span>{zhCN.stats.context} <span data-testid="stat-summary-context">{compact(context!.percent!)}%</span></span>
        </span>
      </span>}
    </button>
  </div>
  <Modal open={details} onClose={() => setDetails(false)} title={zhCN.stats.details}>
    <div className="stats-detail-content">
    {pending && <p title={liveSource}>{liveSource}</p>}
    <div className="stat-group">
      <span className="stat-item" title={executionSource}>{validMetric(loops) ? rawMetric(loops) : zhCN.stats.unknown}  {zhCN.stats.roundsAndTurns} {validMetric(turns) ? rawMetric(turns) : zhCN.stats.unknown} turn</span>
      <span className="stat-item">{zhCN.steps.user} {timeline.filter(i => i.kind === "message" && i.role === "user").length}  {zhCN.steps.countUnit}</span>
      <span className="stat-separator" />
      <span className="stat-item" title={zhCN.stats.loadedToolsScope}>{timeline.filter(i => i.kind === "tool").length}  {zhCN.stats.toolCalls}</span>
    </div>
    <p>{executionSource} {execution?.coverage === "recorded" ? zhCN.stats.partialHistory : execution?.coverage === "complete" ? zhCN.stats.completeHistory : zhCN.stats.unknownExecutionCount}  {zhCN.stats.toolScope}</p>
    {last.some(m => validMetric(m.value)) && <div className="stat-group">
      <span data-testid="stat-scope" title={source}>{zhCN.stats.lastResponse}{pending ? zhCN.stats.previousNonLive : ""}</span>
      <Metrics metrics={last} source={source} />
    </div>}
    {totals && tokenMetrics(totals).some(m => validMetric(m.value)) && <section className="stat-details">
      <h3 data-testid="stat-session-scope" title={zhCN.stats.allEntriesScope}>{zhCN.stats.sessionTotals}</h3>
      <div className="stat-group"><Metrics metrics={tokenMetrics(totals, "session-")} source={zhCN.stats.sessionTotalsHint} /></div>
    </section>}
    {contextMetrics.some(m => validMetric(m.value)) && <div className="stat-group">
      <span title={zhCN.stats.contextScope}>{zhCN.stats.contextTitle}</span>
      <Metrics metrics={contextMetrics} source={zhCN.stats.contextDetails} />
    </div>}
    </div>
  </Modal></>;
}
