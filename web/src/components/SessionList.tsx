import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";

function validTimestamp(timestamp: number): boolean {
  return Number.isFinite(timestamp) && timestamp > 0 && !Number.isNaN(new Date(timestamp).getTime());
}

/** 会话更新时间展示：紧凑弱化的中文相对时间或短日期 */
export function formatSessionTime(updatedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || Number.isNaN(new Date(updatedAt).getTime())) {
    return "";
  }
  if (updatedAt > now) return formatFullSessionTime(updatedAt);
  const diffMs = now - updatedAt;
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

/** Calendar boundaries use local dates, not elapsed 24-hour guesses. */
export function sessionDateGroup(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || Number.isNaN(new Date(timestamp).getTime())) return "日期未知";
  if (timestamp > now) return "未来日期";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 6);
  if (timestamp >= today.getTime()) return "今天";
  if (timestamp >= yesterday.getTime()) return "昨天";
  if (timestamp >= week.getTime()) return "近 7 天";
  return "更早";
}

/** 辅助获取完整绝对时间字符串（用于悬停提示） */
export function formatFullSessionTime(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "";
  }
  const d = new Date(updatedAt);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { hour12: false });
}

/** Literal matching only; React escapes every text fragment, including markup. */
export function highlightSessionTitle(title: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return title;
  const lower = title.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    parts.push(title.slice(start, index), <mark key={index}>{title.slice(index, index + needle.length)}</mark>);
    start = index + needle.length;
    index = lower.indexOf(needle, start);
  }
  parts.push(title.slice(start));
  return parts;
}

export type SessionListProps = {
  sessions: SessionRecord[];
  loading?: boolean;
  projectContext?: (searchToggle: ReactNode) => ReactNode;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onExport: (id: string) => void;
};

/** 会话列表：搜索 + 标题 + 更新时间，支持选中/删除/重命名/导出。 */
export function SessionList({
  sessions,
  loading = false,
  projectContext,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onExport,
}: SessionListProps) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (searchOpen) inputRef.current?.focus();
    else if (restoreFocus.current) {
      toggleRef.current?.focus();
      restoreFocus.current = false;
    }
  }, [searchOpen]);
  function clearSearch() {
    setQuery("");
    inputRef.current?.focus();
  }
  function closeSearch() {
    setQuery("");
    setSearchOpen(false);
    restoreFocus.current = true;
  }

  const now = Date.now();
  // filter creates a copy: sorting must never reorder the controller's array.
  const filtered = sessions.filter((s) =>
    resolveSessionDisplayTitle(s).toLowerCase().includes(query.trim().toLowerCase()),
  ).sort((a, b) => {
    const aValid = validTimestamp(a.updatedAt);
    const bValid = validTimestamp(b.updatedAt);
    if (!aValid || !bValid) return Number(bValid) - Number(aValid);
    return b.updatedAt - a.updatedAt;
  });

  return (
    <section className="session-list" data-testid="session-list">
      {(() => {
        const toggle = <button ref={toggleRef} type="button" className="workbench-search-toggle"
          aria-label="搜索会话" aria-expanded={searchOpen} aria-controls={searchId}
          onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}><Icon name="search" /></button>;
        return projectContext ? projectContext(toggle) : toggle;
      })()}
        <div id={searchId} className="session-search-bar" hidden={!searchOpen}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Keep composition Escape local: it must not dismiss the mobile drawer either.
            event.stopPropagation();
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            closeSearch();
          }}>
          <Icon name="search" />
          <input ref={inputRef} className="session-search" data-testid="session-search"
            type="text" placeholder="搜索会话…" value={query}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onChange={(e) => setQuery(e.target.value)} aria-label="搜索会话" />
          {query !== "" && <button type="button" className="workbench-search-toggle" aria-label="清空搜索"
            title="清空搜索" onClick={clearSearch}><Icon name="close" /></button>}
        </div>
      {loading ? <div className="empty-hint" data-testid="sessions-loading">加载中…</div> : filtered.length === 0 && (
        <div className="empty-hint session-empty" data-testid="empty-sessions">
          {query.trim() ? <><Icon name="search" /><p>未找到相关会话</p><button type="button" onClick={clearSearch}>清空搜索</button></> : "暂无会话"}
        </div>
      )}
      <ul className="session-items">
        {filtered.map((s, index) => (
          <Fragment key={s.id}>
          {(index === 0 || sessionDateGroup(filtered[index - 1]!.updatedAt, now) !== sessionDateGroup(s.updatedAt, now)) &&
            <li className="session-date-group">{sessionDateGroup(s.updatedAt, now)}</li>}
          <li className={`session-item ${s.id === activeId ? "active" : ""}`}>
            <button
              type="button"
              className="session-select"
              aria-label={resolveSessionDisplayTitle(s)}
              aria-current={s.id === activeId ? "true" : undefined}
              aria-describedby={`session-meta-${s.id}`}
              data-testid={`session-${s.id}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="session-title" title={resolveSessionDisplayTitle(s)}>{highlightSessionTitle(resolveSessionDisplayTitle(s), query)}</span>
            <span className="session-meta" id={`session-meta-${s.id}`}>
              <time
                className="session-time"
                data-testid={`session-time-${s.id}`}
                dateTime={Number.isFinite(s.updatedAt) && s.updatedAt > 0 && !Number.isNaN(new Date(s.updatedAt).getTime())
                  ? new Date(s.updatedAt).toISOString()
                  : undefined}
                title={formatFullSessionTime(s.updatedAt)}
              >
                {formatSessionTime(s.updatedAt, now)}
              </time>
              {(s.visibility === "shared" || s.origin === "native") && (
                <span className="session-shared-badge" title={s.origin === "native" ? "原生共享会话" : "共享会话"} aria-label={s.origin === "native" ? "原生共享会话" : "共享会话"}>
                  <Icon name="shared" size={14} />
                </span>
              )}
            </span>
            </button>
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
          </Fragment>
        ))}
      </ul>
    </section>
  );
}
