import { zhCN } from "../i18n/zh-CN.js";
import { formatDateTime } from "../i18n/format.js";
import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu.js";
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
    return zhCN.sessionList.now;
  }
  if (diffMin < 60) {
    return zhCN.sessionList.minutesAgo(diffMin);
  }
  if (diffHour < 24) {
    return zhCN.sessionList.hoursAgo(diffHour);
  }
  if (diffDay < 30) {
    return zhCN.sessionList.daysAgo(diffDay);
  }

  // 跨更长时间或跨年：输出短日期（如 3/1 或 2023/3/1）
  const date = new Date(updatedAt);
  const nowDate = new Date(now);
  const isSameYear = date.getFullYear() === nowDate.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (isSameYear) {
    return zhCN.sessionList.date(month, day);
  }
  return zhCN.sessionList.fullDate(date.getFullYear(), month, day);
}

/** Calendar boundaries use local dates, not elapsed 24-hour guesses. */
export function sessionDateGroup(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || Number.isNaN(new Date(timestamp).getTime())) return zhCN.sessionList.unknownDate;
  if (timestamp > now) return zhCN.sessionList.futureDate;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 6);
  if (timestamp >= today.getTime()) return zhCN.sessionList.today;
  if (timestamp >= yesterday.getTime()) return zhCN.sessionList.yesterday;
  if (timestamp >= week.getTime()) return zhCN.sessionList.lastWeek;
  return zhCN.sessionList.earlier;
}

/** 辅助获取完整绝对时间字符串（用于悬停提示） */
export function formatFullSessionTime(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "";
  }
  const d = new Date(updatedAt);
  return Number.isNaN(d.getTime()) ? "" : formatDateTime(d);
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
  /** Session whose primary request this page sees running (DESIGN.md §5.2). */
  runningId?: string | null;
  /** Bumped by the "/" shortcut to open and focus the search field. */
  searchRequest?: number;
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
  runningId = null,
  searchRequest = 0,
}: SessionListProps) {
  const [query, setQuery] = useState("");
  /** Row whose action menu is open; right-click opens the same menu as ⋯. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
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
  useLayoutEffect(() => {
    if (!searchRequest) return;
    if (searchOpen) inputRef.current?.focus();
    else setSearchOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRequest]);
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
          aria-label={zhCN.sessionList.search} aria-expanded={searchOpen} aria-controls={searchId}
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
            type="text" placeholder={zhCN.sessionList.searchPlaceholder} value={query}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onChange={(e) => setQuery(e.target.value)} aria-label={zhCN.sessionList.search} />
          {query !== "" && <button type="button" className="workbench-search-toggle" aria-label={zhCN.sessionList.clearSearch}
            title={zhCN.sessionList.clearSearch} onClick={clearSearch}><Icon name="close" /></button>}
        </div>
      {loading ? <div className="empty-hint" data-testid="sessions-loading">{zhCN.sidebar.loading}</div> : filtered.length === 0 && (
        <div className="empty-hint session-empty" data-testid="empty-sessions">
          {query.trim() ? <><Icon name="search" /><p>{zhCN.sessionList.noMatches}</p><button type="button" onClick={clearSearch}>{zhCN.sessionList.clearSearch}</button></> : zhCN.sessionList.empty}
        </div>
      )}
      <ul className="session-items">
        {filtered.map((s, index) => (
          <Fragment key={s.id}>
          {(index === 0 || sessionDateGroup(filtered[index - 1]!.updatedAt, now) !== sessionDateGroup(s.updatedAt, now)) &&
            <li className="session-date-group">{sessionDateGroup(s.updatedAt, now)}</li>}
          <li className={`session-item ${s.id === activeId ? "active" : ""}${s.id === runningId ? " running" : ""}`}>
            <button
              type="button"
              className="session-select"
              aria-label={resolveSessionDisplayTitle(s)}
              aria-current={s.id === activeId ? "true" : undefined}
              aria-describedby={s.visibility === "shared" || s.origin === "native" ? `session-meta-${s.id} session-shared-${s.id}` : `session-meta-${s.id}`}
              data-testid={`session-${s.id}`}
              onClick={() => onSelect(s.id)}
              onContextMenu={(event) => { event.preventDefault(); setMenuFor(s.id); }}
            >
              <span className="session-glyph" aria-hidden="true">{s.id === runningId ? "▶" : "·"}</span>
              <span className="session-title" title={resolveSessionDisplayTitle(s)}>{highlightSessionTitle(resolveSessionDisplayTitle(s), query)}</span>
              {(s.visibility === "shared" || s.origin === "native") && (
                <span className="session-shared-badge" id={`session-shared-${s.id}`} title={s.origin === "native" ? zhCN.sessionList.nativeShared : zhCN.sessionList.shared} aria-label={s.origin === "native" ? zhCN.sessionList.nativeShared : zhCN.sessionList.shared}>
                  <Icon name="shared" size={14} />
                </span>
              )}
            <span className="session-meta" id={`session-meta-${s.id}`}>
              {s.id === runningId ? <span className="session-running">{zhCN.run.running}</span> : <time
                className="session-time"
                data-testid={`session-time-${s.id}`}
                dateTime={Number.isFinite(s.updatedAt) && s.updatedAt > 0 && !Number.isNaN(new Date(s.updatedAt).getTime())
                  ? new Date(s.updatedAt).toISOString()
                  : undefined}
                title={formatFullSessionTime(s.updatedAt)}
              >
                {formatSessionTime(s.updatedAt, now)}
              </time>}
            </span>
            </button>
            {/* Row actions live in a menu (DESIGN.md §7): selecting a row never opens a popover. */}
            <DropdownMenu open={menuFor === s.id} onOpenChange={(open) => setMenuFor(open ? s.id : null)}>
              <DropdownMenuTrigger asChild>
                <button type="button" className="session-menu" data-testid={`session-menu-${s.id}`}
                  aria-label={zhCN.sessionList.actions(resolveSessionDisplayTitle(s))} title={zhCN.sessionList.actionsHint}>⋯</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="session-menu-content" aria-label={zhCN.sessionList.actions(resolveSessionDisplayTitle(s))}>
                <DropdownMenuLabel className="session-details">
                  <span className="session-details-time">{zhCN.sessionList.createdAt(formatFullSessionTime(s.createdAt) || zhCN.sessionList.unknownDate)}</span>
                  <span className="session-details-time">{zhCN.sessionList.updatedAt(formatFullSessionTime(s.updatedAt) || zhCN.sessionList.unknownDate)}</span>
                  <span className="session-details-time">{s.origin === "native" ? zhCN.sessionList.nativeShared : s.visibility === "shared" ? zhCN.sessionList.shared : zhCN.sessionList.private}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-testid={`rename-${s.id}`} onSelect={() => {
                  const title = window.prompt(zhCN.sessionList.newTitle, s.title);
                  if (title && title.trim()) onRename(s.id, title.trim());
                }}>{zhCN.sessionList.rename}</DropdownMenuItem>
                <DropdownMenuItem data-testid={`export-${s.id}`} onSelect={() => onExport(s.id)}>{zhCN.sessionList.export}</DropdownMenuItem>
                <DropdownMenuItem data-testid={`delete-${s.id}`} className="session-menu-danger" onSelect={() => onDelete(s.id)}
                  title={s.origin === "native" ? zhCN.sessionList.removeShared : zhCN.sessionList.delete}>
                  {s.origin === "native" ? zhCN.sessionList.removeShared : zhCN.sessionList.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
          </Fragment>
        ))}
      </ul>
    </section>
  );
}
