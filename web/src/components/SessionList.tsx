import type { SessionRecord } from "../types.js";

/** 会话更新时间展示（epoch ms → 本地可读时间）。 */
export function formatSessionTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString();
}

export type SessionListProps = {
  sessions: SessionRecord[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
};

/** 会话列表：标题 + 更新时间，支持选中/新建/删除/重命名。 */
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: SessionListProps) {
  return (
    <aside data-testid="session-list">
      <button data-testid="new-session" onClick={onCreate}>
        新建会话
      </button>
      {sessions.length === 0 && <div data-testid="empty-sessions">暂无会话</div>}
      <ul>
        {sessions.map((s) => (
          <li key={s.id} className={s.id === activeId ? "session-item active" : "session-item"}>
            <button data-testid={`session-${s.id}`} onClick={() => onSelect(s.id)}>
              <span>{s.title}</span>
              <span data-testid={`session-time-${s.id}`}>{formatSessionTime(s.updatedAt)}</span>
            </button>
            <button
              data-testid={`rename-${s.id}`}
              onClick={() => {
                const title = window.prompt("新标题", s.title);
                if (title && title.trim()) onRename(s.id, title.trim());
              }}
            >
              重命名
            </button>
            <button data-testid={`delete-${s.id}`} onClick={() => onDelete(s.id)}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}