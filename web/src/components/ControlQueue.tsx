import { Icon } from "./Icon.js";

export type ControlQueueItem = { id: string; kind: "steer" | "followUp"; text: string; hasImages?: boolean };
export type ControlQueueProps = {
  items: ControlQueueItem[];
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  operations?: Record<string, { status: "pending" | "unknown" | "failed"; error?: string }>;
  onDelete: (id: string) => void;
  onPromote: (id: string) => void;
  onRefresh?: () => void;
};

/** Only authoritative SDK items belong here; submission receipts are not queue entries. */
export function ControlQueue({ items, disabled, loading, error, operations = {}, onDelete, onPromote, onRefresh }: ControlQueueProps) {
  if (!items.length && !error) return null;
  return <>
    {error && <div role="alert" className="control-queue-notice">{error}
      {onRefresh && <button type="button" onClick={onRefresh}>刷新队列</button>}
    </div>}
    {items.length > 0 && <section className="control-queue" aria-label="任务控制队列" data-testid="control-queue">
    {(["steer", "followUp"] as const).map(kind => {
      const rows = items.filter(item => item.kind === kind);
      if (!rows.length) return null;
      return <section key={kind} className={`control-queue-group ${kind}`} aria-label={kind === "steer" ? "引导队列" : "追加队列"}>
        <header><Icon name={kind === "steer" ? "paper-plane" : "clock"} size={kind === "steer" ? 20 : 16} /><strong>{kind === "steer" ? "引导队列" : "追加队列"}</strong><span className="control-queue-count">{rows.length}</span></header>
        <ul>{rows.map(item => {
          const operation = operations[item.id];
          const blocked = disabled || loading || operation?.status === "pending" || operation?.status === "unknown";
          return <li key={item.id} data-testid="control-queue-item">
            <div className="control-queue-copy"><span title={item.text}>{item.text || "图片消息"}{item.text && item.hasImages ? " · 含图片" : ""}</span>
              {operation && <small role="status">{operation.status === "pending" ? "操作中…" : operation.status === "unknown" ? "结果未知，请刷新确认；不会自动重试" : operation.error || "操作失败，条目已保留"}</small>}
            </div>
            <div className="control-queue-actions">
              {kind === "followUp" && <button type="button" disabled={blocked} onClick={() => onPromote(item.id)} aria-label={`引导：${item.text || "图片消息"}`}>引导</button>}
              <button type="button" disabled={blocked} onClick={() => onDelete(item.id)} aria-label={`删除：${item.text || "图片消息"}`}><Icon name="trash" size={19} /></button>
            </div>
          </li>;
        })}</ul>
      </section>;
    })}
    {Object.values(operations).some(operation => operation.status === "unknown") && onRefresh && <button type="button" className="control-queue-refresh" onClick={onRefresh}>刷新队列确认结果</button>}
    </section>}
  </>;
}
