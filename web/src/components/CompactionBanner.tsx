import { useEffect, useState } from "react";
import type { ChatState } from "pi-agent-server/client";

export type CompactionState = NonNullable<ChatState["compaction"]>;

const labels = {
  running: "正在压缩上下文…",
  succeeded: "上下文已压缩",
  failed: "上下文压缩失败",
  aborted: "上下文压缩已取消",
  unknown: "压缩状态待确认",
};
const reasons = { manual: "手动压缩", threshold: "达到上下文阈值", overflow: "上下文超限" };
const isNumber = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const format = (value: number) => value.toLocaleString("zh-CN");

export function CompactionBanner({ compaction, connected }: { compaction?: CompactionState | null; connected: boolean }) {
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
  const disconnectedRunning = compaction.status === "running" && !connected;
  const status = disconnectedRunning ? "unknown" : compaction.status;
  return (
    <div className="compaction-banner mb-2 flex items-start gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-[13px]" data-testid="compaction-banner" data-status={status} role="status" aria-live="polite" aria-atomic="true">
      <span className={`compaction-indicator mt-1 size-2 shrink-0 rounded-full bg-primary${status === "running" ? " is-running animate-pulse" : ""}`} aria-hidden="true" />
      <div className="compaction-content min-w-0">
        <div className="compaction-heading flex flex-wrap items-center gap-2">
          <span>{labels[status]}{disconnectedRunning ? " / 连接中断" : ""}</span>
          <span className="compaction-reason text-[12px] text-muted-foreground" title={reasons[compaction.reason]}>{reasons[compaction.reason]}</span>
        </div>
        {(isNumber(compaction.tokensBefore) || isNumber(compaction.tokensAfter)) && (
          <div className="compaction-tokens mt-1 flex flex-wrap gap-3 font-mono text-[12px] text-muted-foreground">
            {isNumber(compaction.tokensBefore) && <span>压缩前 {format(compaction.tokensBefore)} tokens</span>}
            {isNumber(compaction.tokensAfter) && <span>压缩后（估算）{format(compaction.tokensAfter)} tokens</span>}
          </div>
        )}
      </div>
    </div>
  );
}
