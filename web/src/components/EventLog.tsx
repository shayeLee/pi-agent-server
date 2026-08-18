import { useState } from "react";
import type { EventLogEntry } from "../types.js";

/** 把 unknown 值序列化为可读文本（字符串原样，其它 JSON 美化）。 */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export type EventLogProps = {
  entries: EventLogEntry[];
  onClear: () => void;
  /** 是否展示顶部标题栏；Inspector 内部已由 tab 提供标题，故隐藏。 */
  showHeader?: boolean;
};

const INTERESTING_TYPES = [
  "text_delta",
  "tool_start",
  "tool_update",
  "tool_end",
  "status",
  "queued",
  "completed",
  "aborted",
  "error",
];

/** 调试面板：按到达顺序展示原始 SSE 事件，可按类型过滤、清空。 */
export function EventLog({ entries, onClear, showHeader = true }: EventLogProps) {
  const [filter, setFilter] = useState<string>("all");

  const filtered = entries.filter((e) => filter === "all" || e.type === filter);

  return (
    <aside className="event-log" data-testid="event-log">
      {showHeader ? (
        <header className="panel-header">
          <h3>事件流</h3>
          <div className="panel-actions">
            <select
              data-testid="event-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="按事件类型过滤"
            >
              <option value="all">全部</option>
              {INTERESTING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button data-testid="event-clear" onClick={onClear}>
              清空
            </button>
          </div>
        </header>
      ) : (
        <div className="event-log-toolbar">
          <select
            data-testid="event-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="按事件类型过滤"
          >
            <option value="all">全部</option>
            {INTERESTING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button data-testid="event-clear" onClick={onClear}>
            清空
          </button>
        </div>
      )}
      <div className="event-log-list">
        {filtered.length === 0 ? (
          <div className="empty-hint" data-testid="event-empty">
            暂无事件
          </div>
        ) : (
          filtered.map((e) => (
            <details key={e.seq} className="event-entry" data-testid={`event-${e.seq}`}>
              <summary>
                <span className="event-seq">#{e.seq}</span>
                <span className="event-type" data-type={e.type}>
                  {e.type}
                </span>
                <span className="event-time">{e.time}</span>
              </summary>
              <pre className="event-data">{stringify(e.data)}</pre>
            </details>
          ))
        )}
      </div>
    </aside>
  );
}
