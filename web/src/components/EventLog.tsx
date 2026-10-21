import { zhCN } from "../i18n/zh-CN.js";
import { useState } from "react";
import { Icon } from "./Icon.js";
import { SelectMenu } from "./SelectMenu.js";
import type { EventLogEntry } from "../types.js";
import { useFollowBottom } from "../hooks/useFollowBottom.js";

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
  const scroll = useFollowBottom(filter, entries);

  const filtered = entries.filter((e) => filter === "all" || e.type === filter);
  const filterSelect = (
    <SelectMenu
      testId="event-filter"
      ariaLabel={zhCN.eventLog.filter}
      options={[{ value: "all", label: zhCN.toolParameters.all }, ...INTERESTING_TYPES.map((t) => ({ value: t, label: t }))]}
      value={filter}
      onChange={setFilter}
    />
  );

  return (
    <aside className="event-log" data-testid="event-log">
      {showHeader ? (
        <header className="panel-header">
          <h3>{zhCN.trace.events}</h3>
          <div className="panel-actions">
            {filterSelect}
            <button data-testid="event-clear" onClick={onClear}>
              {zhCN.eventLog.clear}</button>
          </div>
        </header>
      ) : (
        <div className="event-log-toolbar">
          {filterSelect}
          <button data-testid="event-clear" onClick={onClear}>
            {zhCN.eventLog.clear}</button>
        </div>
      )}
      <div className="event-log-list" ref={scroll.ref} onScroll={scroll.onScroll}
        onClickCapture={(event) => { if ((event.target as Element).closest('summary')) scroll.pause(); }}>
        {filtered.length === 0 ? (
          <div className="empty-hint" data-testid="event-empty">
            {zhCN.eventLog.empty}</div>
        ) : (
          filtered.map((e) => (
            <details key={e.seq} className="event-entry" data-testid={`event-${e.seq}`}>
              <summary className="chevron-trigger">
                <span className="event-seq">#{e.seq}</span>
                <span className="event-type" data-type={e.type}>
                  {e.type}
                </span>
                <Icon name="chevron" className="disclosure-chevron details-chevron" />
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
