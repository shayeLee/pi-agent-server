import { zhCN } from "../i18n/zh-CN.js";
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { LEDGER_REVEAL_EVENT, workDurationMs, type WorkItem } from "./ledger.js";
import { formatSpan } from "../i18n/format.js";

const STRIP_LIMIT = 48;
/** Longest name the step column grows to; longer protocol names wrap inside it. */
const NAME_COLUMN_MAX_CH = 28;

/**
 * Width of the steps' name column: as wide as this block's longest tool name (names are
 * monospace, so `ch` is exact), and wide enough for the "正在思考" label when thinking is
 * present, so summaries align within a block without padding short names like `bash`.
 */
export function stepNameColumn(items: WorkItem[]): string {
  const longest = Math.min(NAME_COLUMN_MAX_CH, Math.max(0, ...items.map(item => item.kind === "tool" ? item.call.toolName.length : 0)));
  const thinking = items.some(item => item.kind === "thinking") ? `${zhCN.thinking.thinking.length}em` : "0px";
  return `max(${longest}ch, ${thinking})`;
}

/**
 * Consecutive tool calls (and interleaved thinking) between two assistant texts.
 * Folding only hides steps: every step stays mounted in its original order so trace
 * navigation can still resolve it (DESIGN.md §4.5).
 */
export const WorkBlock = memo(function WorkBlock({ items, active, observed, renderStep }: {
  items: WorkItem[];
  /** The block is still in progress: a step is running, or it is the live tail of the turn. */
  active: boolean;
  observed?: ReadonlyMap<string, string>;
  renderStep: (item: WorkItem, index: number | undefined) => ReactNode;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? active;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reveal = () => flushSync(() => setManual(true));
    root.addEventListener(LEDGER_REVEAL_EVENT, reveal);
    return () => root.removeEventListener(LEDGER_REVEAL_EVENT, reveal);
  }, []);

  const tools = items.filter((item): item is Extract<WorkItem, { kind: "tool" }> => item.kind === "tool");
  const failures = tools.filter(item => item.call.done && item.call.isError).length;
  const running = tools.some(item => !item.call.done);
  const duration = running ? null : workDurationMs(items, observed);
  const shown = tools.length > STRIP_LIMIT ? tools.slice(0, STRIP_LIMIT - 1) : tools;
  let toolIndex = 0;

  return <div className={`work-block${running ? " work-running" : ""}`} ref={rootRef} data-testid="work-block" data-expanded={String(expanded)}>
    <button type="button" className="work-header" aria-expanded={expanded}
      aria-label={expanded ? zhCN.ledger.collapseWork(tools.length) : zhCN.ledger.expandWork(tools.length)}
      onClick={() => setManual(!expanded)}>
      <span className="work-toggle" aria-hidden="true">{expanded ? "−" : "+"}</span>
      <span className="work-count">{zhCN.ledger.steps(tools.length)}</span>
      <span className="work-strip" aria-hidden="true">
        {shown.map(item => <span key={item.id}
          className={`work-cell${!item.call.done ? " is-running" : item.call.isError ? " is-error" : ""}`} />)}
        {tools.length > STRIP_LIMIT && <span className="work-more">{zhCN.ledger.more(tools.length - shown.length)}</span>}
      </span>
      <span className="work-meta">
        {[duration !== null ? formatSpan(duration) : null, failures ? zhCN.ledger.failures(failures) : null].filter(Boolean).join(" · ")}
        {running && <span className="work-running-label">{duration !== null || failures ? " · " : ""}{zhCN.ledger.running}</span>}
      </span>
    </button>
    <div className="work-steps" hidden={!expanded} style={{ "--step-name": stepNameColumn(items) } as CSSProperties}>
      {items.map(item => renderStep(item, item.kind === "tool" ? ++toolIndex : undefined))}
    </div>
  </div>;
});
