import { zhCN } from "../i18n/zh-CN.js";
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
      {onRefresh && <button type="button" onClick={onRefresh}>{zhCN.controlQueue.refresh}</button>}
    </div>}
    {items.length > 0 && <section className="control-queue" aria-label={zhCN.controlQueue.label} data-testid="control-queue">
    {(["steer", "followUp"] as const).map(kind => {
      const rows = items.filter(item => item.kind === kind);
      if (!rows.length) return null;
      return <section key={kind} className="control-queue-group" aria-label={kind === "steer" ? zhCN.controlQueue.steerQueue : zhCN.controlQueue.followUpQueue}>
        <ul>{rows.map((item, index) => {
          const position = index + 1 + (kind === "followUp" ? items.filter(item => item.kind === "steer").length : 0);
          const operation = operations[item.id];
          const blocked = disabled || loading || operation?.status === "pending" || operation?.status === "unknown";
          return <li key={item.id} className={`control-queue-row ${kind}`} data-testid="control-queue-item">
            <header><Icon name={kind === "steer" ? "paper-plane" : "clock"} size={kind === "steer" ? 20 : 16} /><strong>{kind === "steer" ? zhCN.controlQueue.steerQueue : zhCN.controlQueue.followUpQueue}</strong><span className="control-queue-count" aria-label={`第 ${position} 条`}>{position}</span></header>
            <div className="control-queue-content">
            <div className="control-queue-copy"><span title={item.text}>{item.text || zhCN.controlQueue.imageMessage}{item.text && item.hasImages ? zhCN.controlQueue.withImages : ""}</span>
              {operation && <small role="status">{operation.status === "pending" ? zhCN.controlQueue.pending : operation.status === "unknown" ? zhCN.controlQueue.unknown : operation.error || zhCN.controlQueue.failed}</small>}
            </div>
            <div className="control-queue-actions">
              {kind === "followUp" && <button className="control-queue-promote" type="button" disabled={blocked} onClick={() => onPromote(item.id)} aria-label={zhCN.controlQueue.steerMessage(item.text || zhCN.controlQueue.imageMessage)}>{zhCN.controlQueue.steer}</button>}
              <button type="button" disabled={blocked} onClick={() => onDelete(item.id)} aria-label={zhCN.controlQueue.deleteMessage(item.text || zhCN.controlQueue.imageMessage)}><Icon name="trash" size={19} /></button>
            </div>
            </div>
          </li>;
        })}</ul>
      </section>;
    })}
    {Object.values(operations).some(operation => operation.status === "unknown") && onRefresh && <button type="button" className="control-queue-refresh" onClick={onRefresh}>{zhCN.controlQueue.refreshResult}</button>}
    </section>}
  </>;
}
