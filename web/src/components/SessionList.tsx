import { useState } from "react";
import { Icon } from "./Icon.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";

/** 会话更新时间展示：紧凑弱化的中文相对时间或短日期 */
export function formatSessionTime(updatedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || Number.isNaN(new Date(updatedAt).getTime())) {
    return "";
  }
  const diffMs = Math.max(0, now - updatedAt);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) {
    return "刚刚";
  }
  if (diffMin < 60) {
    return `${diffMin}分钟前`;
  }
  if (diffHour < 24) {
    return `${diffHour}小时前`;
  }
  if (diffDay < 30) {
    return `${diffDay}天前`;
  }

  // 跨更长时间或跨年：输出短日期（如 3/1 或 2023/3/1）
  const date = new Date(updatedAt);
  const nowDate = new Date(now);
  const isSameYear = date.getFullYear() === nowDate.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (isSameYear) {
    return `${month}月${day}日`;
  }
  return `${date.getFullYear()}/${month}/${day}`;
}

/** 辅助获取完整绝对时间字符串（用于悬停提示） */
export function formatFullSessionTime(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "";
  }
  const d = new Date(updatedAt);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { hour12: false });
}

export type SessionListProps = {
  sessions: SessionRecord[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onExport: (id: string) => void;
};

/** 会话列表：搜索 + 标题 + 更新时间，支持选中/删除/重命名/导出。 */
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onExport,
}: SessionListProps) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const filtered = sessions.filter((s) =>
    resolveSessionDisplayTitle(s).toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <section className="session-list" data-testid="session-list">
      <div className="session-list-header">
        <span>会话历史</span>
        <button
        type="button"
        className="workbench-search-toggle"
        aria-label="搜索会话"
        aria-expanded={searchOpen}
        onClick={() => setSearchOpen((open) => !open)}
      >
        <Icon name="search" />
        </button>
      </div>
      <input
        className="session-search"
        data-testid="session-search"
        type="search"
        hidden={!searchOpen}
        placeholder="搜索会话…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="搜索会话"
      />
      {filtered.length === 0 && (
        <div className="empty-hint" data-testid="empty-sessions">
          暂无会话
        </div>
      )}
      <ul className="session-items">
        {filtered.map((s) => (
          <li key={s.id} className={`session-item ${s.id === activeId ? "active" : ""}`}>
            <button
              type="button"
              className="session-select"
              aria-label={resolveSessionDisplayTitle(s)}
              aria-current={s.id === activeId ? "true" : undefined}
              aria-describedby={`session-meta-${s.id}`}
              data-testid={`session-${s.id}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="session-title" title={resolveSessionDisplayTitle(s)}>{resolveSessionDisplayTitle(s)}</span>
            </button>
            <div className="session-meta" id={`session-meta-${s.id}`}>
              <time
                className="session-time"
                data-testid={`session-time-${s.id}`}
                dateTime={Number.isFinite(s.updatedAt) && s.updatedAt > 0 && !Number.isNaN(new Date(s.updatedAt).getTime())
                  ? new Date(s.updatedAt).toISOString()
                  : undefined}
                title={formatFullSessionTime(s.updatedAt)}
              >
                {formatSessionTime(s.updatedAt)}
              </time>
              {(s.visibility === "shared" || s.origin === "native") && (
                <span className="session-shared-badge" title={s.origin === "native" ? "原生共享会话" : "共享会话"} aria-label={s.origin === "native" ? "原生共享会话" : "共享会话"}>
                  <Icon name="shared" size={14} />
                </span>
              )}
            </div>
            <div className="session-actions">
              <button
                data-testid={`rename-${s.id}`}
                title="重命名"
                aria-label="重命名"
                onClick={() => {
                  const title = window.prompt("新标题", s.title);
                  if (title && title.trim()) onRename(s.id, title.trim());
                }}
              >
                <Icon name="edit" />
              </button>
              <button
                data-testid={`export-${s.id}`}
                title="导出 JSON"
                aria-label="导出 JSON"
                onClick={() => onExport(s.id)}
              >
                <Icon name="download" />
              </button>
              <button
                data-testid={`delete-${s.id}`}
                title={s.origin === "native" ? "从共享列表移除（保留原始文件）" : "删除"}
                aria-label="删除"
                onClick={() => onDelete(s.id)}
              >
                <Icon name="trash" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
