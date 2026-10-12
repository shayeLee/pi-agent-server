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
  { id: `${prefix}input`, label: "输入", value: tokens.input },
  { id: `${prefix}output`, label: "输出", value: tokens.output },
  { id: `${prefix}cache-read`, label: "缓存读", value: tokens.cacheRead },
  { id: `${prefix}cache-write`, label: "缓存写", value: tokens.cacheWrite },
  { id: `${prefix}tokens`, label: "总计", value: tokens.totalTokens },
  { id: `${prefix}cost`, label: "费用估算", value: tokens.costUsdEstimate, unit: "USD" },
];
function Metrics({ metrics, source }: { metrics: Metric[]; source: string }) {
  return metrics.filter(m => validMetric(m.value)).map(({ id, label, value, unit }) => {
    const n = value as number;
    const formatted = unit === "毫秒" ? formatDuration(n) : unit === "USD" ? `${n === 0 ? "0" : n < 0.001 ? n.toPrecision(2) : n.toLocaleString("en-US", { maximumSignificantDigits: 4 })} USD` : `${formatTokens(n)}${unit ? ` ${unit}` : ""}`;
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
  const liveLabel = !connected ? "连接已断开" : active ? "最近收到模型输出" : tools ? "工具执行中" : "等待模型输出";
  const response = stats?.lastResponse;
  const last: Metric[] = stats ? response ? [
    ...tokenMetrics(response),
    { id: "cache-hit", label: "缓存命中", value: response.cacheHitPercent, unit: "%" },
    { id: "speed", label: "输出速度", value: !pending && validMetric(response.speed?.generationDurationMs) && response.speed.generationDurationMs >= 10 ? response.speed.tokensPerSecond : null, unit: "tok/s" },
  ] : stats.lastResponse === undefined ? [
    { id: "input", label: "输入", value: stats.promptTokens },
    { id: "output", label: "输出", value: stats.completionTokens },
    { id: "tokens", label: "总计", value: stats.totalTokens },
  ] : [] : [];
  if (stats) last.push(
    { id: "duration", label: "请求耗时", value: stats.durationMs, unit: "毫秒" },
    { id: "ttft", label: "首段延迟", value: validMetric(stats.durationMs) && stats.ttftMs < stats.durationMs ? stats.ttftMs : null, unit: "毫秒" },
  );
  const execution = stats?.execution;
  const loops = execution?.coverage === "complete" ? execution.totalLoops : execution?.recordedLoops;
  const turns = execution?.coverage === "complete" ? execution.totalTurns : execution?.recordedTurns;
  const executionSource = "服务端实际执行任务为一轮（含重试、工具后续和活动 follow-up）；每次真实 turn_start 计一个 turn，已开始后中止仍计数。所有分支累计，稳定 ID 去重；非用户消息数，非当前分支工具数。";
  const totals = stats?.sessionTotals;
  const context = stats?.context;
  const source = "末次 assistant SDK usage，非请求或会话累计；输入不含缓存，输出含 reasoning，总计不自行加总。费用为 USD 估算，0 不表示免费。速度为完成响应首个非空 delta 至结束的 output tok/s，包含流内停顿，不含工具等待；非实时。请求耗时含工具及统计等待；首段延迟为请求至首个正文/思考 delta，无 delta 回填不显示。未知省略，已测零显示 0。";
  const total = response?.totalTokens;
  const speed = last.find(m => m.id === "speed")?.value;
  const toolCount = timeline.filter(i => i.kind === "tool").length;
  const liveSource = `${liveLabel}。仅最近 2 秒收到非空模型 delta 表示活动；字符数 / 4 估算，含思考及工具参数，不含工具结果；每条 assistant 独立计时，含流内停顿。`;
  const activityMetrics: { id: string; content: ReactNode }[] = [];
  if (validMetric(loops)) activityMetrics.push({ id: "loops", content: <span data-testid="stat-turns" title={executionSource}>{compact(loops)} 轮</span> });
  if (validMetric(turns)) activityMetrics.push({ id: "turns", content: <span data-testid="stat-model-turns" title={executionSource}>{compact(turns)} turn</span> });
  if (validMetric(toolCount) && toolCount > 0) activityMetrics.push({ id: "tools", content: <span data-testid="stat-steps" title="当前已加载分支时间线的工具调用数">工具 {compact(toolCount)} 次</span> });
  if (pending && active && validMetric(modelOutput?.tokensPerSecondEstimate)) activityMetrics.push({ id: "live-speed", content: <span data-testid="stat-live-speed" title={liveSource}>~{compact(modelOutput.tokensPerSecondEstimate)} tok/s</span> });
  else if (!pending && validMetric(speed)) activityMetrics.push({ id: "speed", content: <span data-testid="stat-summary-speed" title={source}>{compact(speed)} tok/s</span> });
  const contextMetrics: Metric[] = context ? [
    { id: "context-percent", label: "占用", value: context.percent, unit: "%" },
    { id: "context-tokens", label: "tokens", value: context.tokens },
    { id: "context-window", label: "窗口", value: context.window },
  ] : [];
  const hasLeft = activityMetrics.length > 0 || validMetric(total);
  const hasRight = validMetric(context?.percent);
  return <><div className="stats-bar" data-testid="stats-bar">
    <button type="button" className="stats-summary" aria-label="查看统计详情" aria-haspopup="dialog" onClick={() => setDetails(true)}>
      {hasLeft && <span className="stats-group-left">
        {activityMetrics.length > 0 && <span className="stats-cluster">
          <Icon name="activity" />
          {activityMetrics.map((metric, index) => <span key={metric.id}>{index > 0 && " · "}{metric.content}</span>)}
        </span>}
        {validMetric(total) && <span className="stats-cluster" title={`末次响应 totalTokens：${rawMetric(total)} tokens。${source}${pending ? "上次快照，非实时。" : ""}`}><Icon name="tokens" /><span data-testid="stat-summary-tokens">{compact(total)} tok</span>
          {validMetric(response?.cacheHitPercent) && <span className="stats-cache" title={`末次响应缓存命中：${rawMetric(response!.cacheHitPercent!)}%`}>· 缓存命中 {compact(response!.cacheHitPercent!)}%</span>}
        </span>}
      </span>}
      {hasRight && <span className="stats-group-right">
        <span className="stats-cluster" title={`SDK 当前上下文估算：${rawMetric(context!.percent!)}%；上次结算/export 快照，非实时，非累计。`}>
          <Icon name="context" />
          <span>上下文 <span data-testid="stat-summary-context">{compact(context!.percent!)}%</span></span>
        </span>
      </span>}
    </button>
  </div>
  <Modal open={details} onClose={() => setDetails(false)} title="统计详情">
    <div className="stats-detail-content">
    {pending && <p title={liveSource}>{liveSource}</p>}
    <div className="stat-group">
      <span className="stat-item" title={executionSource}>{validMetric(loops) ? rawMetric(loops) : "未知"} 轮 · {validMetric(turns) ? rawMetric(turns) : "未知"} turn</span>
      <span className="stat-item">用户消息 {timeline.filter(i => i.kind === "message" && i.role === "user").length} 条</span>
      <span className="stat-separator" />
      <span className="stat-item" title="当前已加载时间线的工具调用数">{timeline.filter(i => i.kind === "tool").length} 次工具调用</span>
    </div>
    <p>{executionSource} {execution?.coverage === "recorded" ? "已记录范围：仅启用记录后的执行；旧历史有缺口，全历史总数未知。" : execution?.coverage === "complete" ? "完整记录；会话累计包含当前文件所有分支及继承的 fork 记录。" : "执行计数未知：旧历史没有记录或服务端不提供此字段，不以用户消息数推算。"} 工具次数仅当前已加载分支，与会话累计范围不同。</p>
    {last.some(m => validMetric(m.value)) && <div className="stat-group">
      <span data-testid="stat-scope" title={source}>末次响应{pending ? " · 上次·非实时" : ""}</span>
      <Metrics metrics={last} source={source} />
    </div>}
    {totals && tokenMetrics(totals).some(m => validMetric(m.value)) && <section className="stat-details">
      <h3 data-testid="stat-session-scope" title="SDK allEntries 累计含所有分支条目、压缩前条目及摘要 usage；非 active branch，不另加 subagent ledger，不表示已包含独立子 agent 账本。结算/export 上次快照，非实时。">会话累计 · 所有分支条目 · 上次快照</h3>
      <div className="stat-group"><Metrics metrics={tokenMetrics(totals, "session-")} source="SDK allEntries；上次结算/export 快照，非实时；USD 费用估算，0 不代表免费。" /></div>
    </section>}
    {contextMetrics.some(m => validMetric(m.value)) && <div className="stat-group">
      <span title="SDK 当前上下文估算，非累计；上次结算/export 采样，非实时。压缩后 tokens/percent 可能未知，未知不显示为 0。">上下文 · 估算 · 上次快照</span>
      <Metrics metrics={contextMetrics} source="SDK getContextUsage 估算；上次结算/export 快照，非实时，非累计。" />
    </div>}
    </div>
  </Modal></>;
}
