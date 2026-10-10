import { useState } from "react";
import { IconSelect } from "./IconSelect.js";
import { Icon } from "./Icon.js";
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
    <aside className="event-log flex h-full min-h-0 flex-col" data-testid="event-log">
      {showHeader ? (
        <header className="panel-header flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h3 className="text-[13px] font-semibold">事件流</h3>
          <div className="panel-actions flex items-center gap-2">
            <IconSelect
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
            </IconSelect>
            <button className="h-7 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent" data-testid="event-clear" onClick={onClear}>
              清空
            </button>
          </div>
        </header>
      ) : (
        <div className="event-log-toolbar flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <IconSelect
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
          </IconSelect>
          <button className="h-7 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent" data-testid="event-clear" onClick={onClear}>
            清空
          </button>
        </div>
      )}
      <div className="event-log-list min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="empty-hint px-3 py-6 text-center text-[13px] text-muted-foreground" data-testid="event-empty">
            暂无事件
          </div>
        ) : (
          filtered.map((e) => (
            <details key={e.seq} className="event-entry border-b border-border" data-testid={`event-${e.seq}`}>
              <summary className="chevron-trigger flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px]">
                <span className="event-seq font-mono text-muted-foreground">#{e.seq}</span>
                <span className="event-type font-mono text-foreground" data-type={e.type}>
                  {e.type}
                </span>
                <Icon name="chevron" className="disclosure-chevron details-chevron" />
                <span className="event-time ml-auto text-muted-foreground">{e.time}</span>
              </summary>
              <pre className="event-data mx-3 mb-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[12px]">{stringify(e.data)}</pre>
            </details>
          ))
        )}
      </div>
    </aside>
  );
}
