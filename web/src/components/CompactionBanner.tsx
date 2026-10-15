import { zhCN } from "../i18n/zh-CN.js";
import { formatExact } from "../i18n/format.js";
import { useEffect, useState } from "react";
import type { ChatState } from "pi-agent-server/client";

export type CompactionState = NonNullable<ChatState["compaction"]>;

const labels = {
  running: zhCN.compaction.running,
  succeeded: zhCN.compaction.completed,
  failed: zhCN.compaction.failed,
  aborted: zhCN.compaction.cancelled,
  unknown: zhCN.compaction.unknown,
};
const reasons = { manual: zhCN.compaction.manual, threshold: zhCN.compaction.threshold, overflow: zhCN.compaction.overflow };
const isNumber = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const format = formatExact;

/** `streamLost`: the event stream dropped and is being retried (not merely still connecting). */
export function CompactionBanner({ compaction, streamLost = false }: { compaction?: CompactionState | null; streamLost?: boolean }) {
  const [hidden, setHidden] = useState(false);
  const sourceStatus = compaction?.status;
  useEffect(() => {
    setHidden(false);
    if (compaction?.status !== "succeeded") return;
    const timer = setTimeout(() => setHidden(true), 5000);
    return () => clearTimeout(timer);
    // Each compaction event creates a new state object; unrelated chat updates
    // preserve its identity. This also catches batched start/end in one request.
  }, [compaction]);

  if (!compaction || (sourceStatus === "succeeded" && hidden)) return null;
  const disconnectedRunning = compaction.status === "running" && streamLost;
  const status = disconnectedRunning ? "unknown" : compaction.status;
  return (
    <div className="compaction-banner" data-testid="compaction-banner" data-status={status} role="status" aria-live="polite" aria-atomic="true">
      <span className={`compaction-indicator${status === "running" ? " is-running" : ""}`} aria-hidden="true" />
      <div className="compaction-content">
        <div className="compaction-heading">
          <span>{labels[status]}{disconnectedRunning ? zhCN.compaction.disconnected : ""}</span>
          <span className="compaction-reason" title={reasons[compaction.reason]}>{reasons[compaction.reason]}</span>
        </div>
        {(isNumber(compaction.tokensBefore) || isNumber(compaction.tokensAfter)) && (
          <div className="compaction-tokens">
            {isNumber(compaction.tokensBefore) && <span>{zhCN.compaction.before} {format(compaction.tokensBefore)} tokens</span>}
            {isNumber(compaction.tokensAfter) && <span>{zhCN.compaction.after}{format(compaction.tokensAfter)} tokens</span>}
          </div>
        )}
      </div>
    </div>
  );
}
