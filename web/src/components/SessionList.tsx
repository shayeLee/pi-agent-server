import { useState } from "react";
import type { SessionRecord } from "../types.js";

/** 会话更新时间展示（epoch ms → 本地可读时间）。 */
export function formatSessionTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString();
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

  const filtered = sessions.filter((s) =>
    s.title.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <aside className="session-list" data-testid="session-list">
      <input
        className="session-search"
        data-testid="session-search"
        type="search"
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
              className="session-select"
              data-testid={`session-${s.id}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="session-title">{s.title || "（未命名）"}</span>
              <span className="session-time" data-testid={`session-time-${s.id}`}>
                {formatSessionTime(s.updatedAt)}
              </span>
            </button>
            <div className="session-actions">
              <button
                data-testid={`rename-${s.id}`}
                title="重命名"
                onClick={() => {
                  const title = window.prompt("新标题", s.title);
                  if (title && title.trim()) onRename(s.id, title.trim());
                }}
              >
                重命名
              </button>
              <button
                data-testid={`export-${s.id}`}
                title="导出 JSON"
                onClick={() => onExport(s.id)}
              >
                导出
              </button>
              <button
                data-testid={`delete-${s.id}`}
                title="删除"
                onClick={() => onDelete(s.id)}
              >
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
