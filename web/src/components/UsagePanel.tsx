import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ModelUsage, UsageBucket, UsagePeriod, UsageReport, UsageTotals } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { formatCompact, formatExact, formatTokens, formatUsd, formatUsagePeriod, localTimeZone } from "../i18n/format.js";
import { Modal } from "./Modal.js";

type UsageApi = { getUsage(query: { period: UsagePeriod; timeZone: string }): Promise<UsageReport> };
type Metric = "tokens" | "cost";
const text = zhCN.usage;
/** Models drawn in their own color; the rest share "other". Matches the validated categorical slots. */
const SERIES = 5;
const OTHER = "\u0000other";

const modelKey = (row: Pick<ModelUsage, "provider" | "model">) => `${row.provider}/${row.model}`;
const modelName = (row: Pick<ModelUsage, "provider" | "model">) =>
  row.model === "unknown" ? text.unknownModel : row.provider === "unknown" ? row.model : `${row.provider}/${row.model}`;
const amount = (totals: UsageTotals, metric: Metric) => metric === "tokens" ? totals.totalTokens : totals.costUsdEstimate;
/** `30 天`, `12 周`, `12 个月`: the length of the report's range. */
const spanOf = (report: UsageReport) => text.span[report.period](report.buckets.length);
const amountText = (value: number, metric: Metric) => metric === "tokens" ? formatTokens(value) : formatUsd(value);

/** A round axis top and step: 1, 2 or 5 times a power of ten, three steps. */
export function axisScale(max: number): { top: number; step: number } {
  if (!(max > 0)) return { top: 1, step: 1 / 3 };
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(n => n * power).find(n => n >= raw)!;
  return { top: step * Math.ceil(max / step), step };
}

export function useUsagePanel({ api }: { api: UsageApi }): { available: boolean; openPanel: () => void; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const openPanel = useCallback(() => setOpen(true), []);
  return { available: true, openPanel, dialog: <Modal open={open} onClose={() => setOpen(false)} title={text.title} className="usage-dialog">
    {open && <UsagePanel api={api} />}
  </Modal> };
}

export function UsagePanel({ api }: { api: UsageApi }) {
  const [period, setPeriod] = useState<UsagePeriod>("day");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; report: UsageReport }>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState(previous => previous.kind === "ready" && previous.report.period === period ? previous : { kind: "loading" });
    setSelected(null);
    api.getUsage({ period, timeZone: localTimeZone() }).then(
      report => { if (current) setState({ kind: "ready", report }); },
      error => { if (current) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [api, period, attempt]);

  return <div className="usage" data-testid="usage-panel">
    <p className="usage-intro">{text.intro}</p>
    <div className="usage-controls">
      <Segmented label={text.periodGroup} value={period} onChange={setPeriod} options={(["day", "week", "month"] as const).map(id => ({ id, label: text.periods[id] }))} testid="usage-period" />
      <Segmented label={text.metricGroup} value={metric} onChange={setMetric} options={(["tokens", "cost"] as const).map(id => ({ id, label: text.metrics[id] }))} testid="usage-metric" />
      {state.kind === "ready" && state.report.period === period && <span className="usage-range" data-testid="usage-range">
        {text.range(spanOf(state.report), formatUsagePeriod(state.report.from, "day", true), formatUsagePeriod(state.report.to, "day", true))}
      </span>}
    </div>
    {state.kind === "loading" && <p className="usage-note" role="status">{text.loading}</p>}
    {state.kind === "error" && <p className="usage-note" role="alert">{text.loadFailed(state.message)} <button type="button" className="btn-ghost" onClick={() => setAttempt(n => n + 1)}>{text.retry}</button></p>}
    {state.kind === "ready" && state.report.period === period && <UsageReportView report={state.report} metric={metric} selected={selected} onSelect={setSelected} />}
  </div>;
}

function Segmented<T extends string>({ label, value, options, onChange, testid }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void; testid: string }) {
  return <div className="usage-segmented" role="radiogroup" aria-label={label} data-testid={testid}>
    {options.map(option => <button key={option.id} type="button" role="radio" aria-checked={option.id === value} data-value={option.id}
      onClick={() => onChange(option.id)}>{option.label}</button>)}
  </div>;
}

type Series = { key: string; label: string; slot: number | null };

function UsageReportView({ report, metric, selected, onSelect }: { report: UsageReport; metric: Metric; selected: string | null; onSelect: (start: string | null) => void }) {
  // Color follows the model: slots by whole-range tokens, so switching the metric never repaints.
  const series = useMemo<Series[]>(() => {
    const named = report.models.slice(0, report.models.length > SERIES ? SERIES - 1 : SERIES)
      .map((row, slot) => ({ key: modelKey(row), label: modelName(row), slot }));
    return report.models.length > named.length ? [...named, { key: OTHER, label: text.other, slot: null }] : named;
  }, [report]);
  const bucket = report.buckets.find(b => b.start === selected) ?? null;
  const span = spanOf(report);
  const rows = bucket ? bucket.models : report.models;
  const totals = bucket ? bucket.totals : report.totals;
  return <>
    <dl className="usage-summary" data-testid="usage-summary">
      <div><dt>{text.total(span)}</dt><dd title={zhCN.units.exactTokens(formatExact(report.totals.totalTokens))}>{formatTokens(report.totals.totalTokens)}</dd></div>
      <div><dt>{text.cost(span)}</dt><dd>{formatUsd(report.totals.costUsdEstimate)}</dd></div>
      <div><dt>{text.calls(span)}</dt><dd>{formatCompact(report.totals.calls)}</dd></div>
      <div><dt>{text.sessionsLabel}</dt><dd>{text.sessions(report.sessions)}</dd></div>
    </dl>
    {report.unreadSessions > 0 && <p className="usage-note" role="note">{text.unread(report.unreadSessions)}</p>}
    {report.totals.calls === 0 ? <p className="usage-note">{text.empty}</p> : <>
      <Legend series={series} />
      <Chart report={report} series={series} metric={metric} selected={selected} onSelect={onSelect} label={text.chartLabel[report.period]} />
      <div className="usage-table-head">
        <h3>{bucket ? formatUsagePeriod(bucket.start, report.period, true) : text.tableAll(span)}</h3>
        {bucket && <button type="button" className="btn-ghost" data-testid="usage-show-all" onClick={() => onSelect(null)}>{text.showAll(span)}</button>}
      </div>
      <ModelTable rows={rows} totals={totals} series={series} />
      <p className="usage-note">{text.costNote}</p>
    </>}
  </>;
}

const swatchClass = (slot: number | null) => slot === null ? "usage-swatch usage-swatch-other" : `usage-swatch usage-series-${slot + 1}`;

function Legend({ series }: { series: Series[] }) {
  return <ul className="usage-legend" data-testid="usage-legend">
    {series.map(s => <li key={s.key}><span className={swatchClass(s.slot)} aria-hidden="true" />{s.label}</li>)}
  </ul>;
}

/** Each bucket's amounts per drawn series, bottom (biggest model) first. */
function stack(bucket: UsageBucket, series: Series[], metric: Metric): Array<{ series: Series; value: number }> {
  const named = new Map(series.filter(s => s.key !== OTHER).map(s => [s.key, s]));
  const values = new Map<string, number>();
  for (const row of bucket.models) {
    const key = named.has(modelKey(row)) ? modelKey(row) : OTHER;
    values.set(key, (values.get(key) ?? 0) + amount(row, metric));
  }
  return series.map(s => ({ series: s, value: values.get(s.key) ?? 0 })).filter(part => part.value > 0);
}

function Chart({ report, series, metric, selected, onSelect, label }: { report: UsageReport; series: Series[]; metric: Metric; selected: string | null; onSelect: (start: string | null) => void; label: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const { top, step } = axisScale(Math.max(0, ...report.buckets.map(b => amount(b.totals, metric))));
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  // Keep roughly eight readable axis labels whatever the bucket count.
  const every = Math.max(1, Math.ceil(report.buckets.length / 8));
  const tick = (value: number) => metric === "tokens" ? formatCompact(value) : formatUsd(value);
  const focus = report.buckets.find(b => b.start === hover) ?? null;
  const focusIndex = focus ? report.buckets.indexOf(focus) : -1;
  return <figure className="usage-chart" aria-label={label} data-testid="usage-chart">
    <div className="usage-plot">
      <div className="usage-grid" aria-hidden="true">
        {ticks.map(value => <span key={value} style={{ bottom: `${value / top * 100}%` }}><em>{tick(value)}</em></span>)}
      </div>
      <div className="usage-bars" onMouseLeave={() => setHover(null)}>
        {report.buckets.map(b => {
          const parts = stack(b, series, metric);
          const name = formatUsagePeriod(b.start, report.period, true);
          return <button key={b.start} type="button" className="usage-bar" data-start={b.start} aria-pressed={selected === b.start}
            aria-label={`${name}：${amountText(amount(b.totals, metric), metric)}`}
            onMouseEnter={() => setHover(b.start)} onFocus={() => setHover(b.start)} onBlur={() => setHover(null)}
            onClick={() => onSelect(selected === b.start ? null : b.start)}>
            <span className="usage-stack" style={{ height: `${amount(b.totals, metric) / top * 100}%` }}>
              {parts.map(part => <span key={part.series.key} className={swatchClass(part.series.slot)} style={{ flexGrow: part.value }} />)}
            </span>
          </button>;
        })}
      </div>
      {focus && <Tooltip bucket={focus} report={report} series={series} metric={metric} position={(focusIndex + 0.5) / report.buckets.length} />}
    </div>
    <div className="usage-axis" aria-hidden="true">
      {report.buckets.map((b, i) => <span key={b.start}>{i % every === 0 ? formatUsagePeriod(b.start, report.period) : ""}</span>)}
    </div>
  </figure>;
}

function Tooltip({ bucket, report, series, metric, position }: { bucket: UsageBucket; report: UsageReport; series: Series[]; metric: Metric; position: number }) {
  const parts = stack(bucket, series, metric).reverse();
  return <div className="usage-tooltip" role="presentation" style={{ left: `${position * 100}%` }} data-side={position > 0.5 ? "left" : "right"}>
    <strong>{formatUsagePeriod(bucket.start, report.period, true)}</strong>
    <span className="usage-tooltip-total">{amountText(amount(bucket.totals, metric), metric)}</span>
    {parts.map(part => <span key={part.series.key} className="usage-tooltip-row">
      <span className={swatchClass(part.series.slot)} aria-hidden="true" /><span>{part.series.label}</span><span>{amountText(part.value, metric)}</span>
    </span>)}
  </div>;
}

function ModelTable({ rows, totals, series }: { rows: ModelUsage[]; totals: UsageTotals; series: Series[] }) {
  const slots = new Map(series.map(s => [s.key, s.slot]));
  const c = text.columns;
  const cells = (t: UsageTotals) => <>
    <td>{formatCompact(t.input)}</td><td>{formatCompact(t.output)}</td><td>{formatCompact(t.cacheRead)}</td><td>{formatCompact(t.cacheWrite)}</td>
    <td title={t.subagentTokens > 0 ? text.subagentShare(formatTokens(t.subagentTokens)) : undefined}>{formatCompact(t.totalTokens)}</td>
    <td>{formatUsd(t.costUsdEstimate)}</td><td>{formatCompact(t.calls)}</td>
  </>;
  return <div className="usage-table-wrap">
    <table className="usage-table" data-testid="usage-table">
      <thead><tr><th scope="col">{c.model}</th><th scope="col">{c.input}</th><th scope="col">{c.output}</th><th scope="col">{c.cacheRead}</th><th scope="col">{c.cacheWrite}</th><th scope="col">{c.total}</th><th scope="col">{c.cost}</th><th scope="col">{c.calls}</th></tr></thead>
      <tbody>
        {rows.map(row => <tr key={modelKey(row)}>
          <th scope="row"><span className={swatchClass(slots.has(modelKey(row)) ? slots.get(modelKey(row))! : null)} aria-hidden="true" />{modelName(row)}</th>
          {cells(row)}
        </tr>)}
      </tbody>
      <tfoot><tr><th scope="row">{text.columns.total}</th>{cells(totals)}</tr></tfoot>
    </table>
  </div>;
}
