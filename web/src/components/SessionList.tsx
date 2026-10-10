import { useMemo, useState } from "react";
import { Icon } from "./Icon.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";
import { useI18n } from "../i18n/I18nProvider.js";
import { groupSessionsByTime, sessionGroupLabelKey } from "../lib/session-groups.js";
import { cn } from "../lib/utils.js";

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

function SessionRow({
  session,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onExport,
  t,
}: {
  session: SessionRecord;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onExport: (id: string) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const title = resolveSessionDisplayTitle(session);
  const native = session.origin === "native";
  return (
    <li className={cn("session-item group/session relative grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-md", session.id === activeId && "active")}>
      <button
        type="button"
        className="session-select col-span-2 flex w-full min-w-0 items-center bg-transparent px-3 pt-2 text-left"
        aria-label={title}
        aria-current={session.id === activeId ? "true" : undefined}
        aria-describedby={`session-meta-${session.id}`}
        data-testid={`session-${session.id}`}
        onClick={() => onSelect(session.id)}
      >
        <span className="session-title block min-w-0 truncate text-[13px]" title={title}>{title}</span>
      </button>
      <div className="session-meta flex items-center gap-1.5 px-3 pb-1 text-[12px] text-muted-foreground" id={`session-meta-${session.id}`}>
        <time
          className="session-time"
          data-testid={`session-time-${session.id}`}
          dateTime={Number.isFinite(session.updatedAt) && session.updatedAt > 0 && !Number.isNaN(new Date(session.updatedAt).getTime())
            ? new Date(session.updatedAt).toISOString()
            : undefined}
          title={formatFullSessionTime(session.updatedAt)}
        >
          {formatSessionTime(session.updatedAt)}
        </time>
        {(session.visibility === "shared" || session.origin === "native") && (
          <span className="session-shared-badge" title={native ? "原生共享会话" : "共享会话"} aria-label={native ? "原生共享会话" : "共享会话"}>
            <Icon name="shared" size={14} />
          </span>
        )}
      </div>
      <div className="session-actions mr-1 flex gap-0.5 opacity-0 group-hover/session:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <button
          data-testid={`rename-${session.id}`}
          title={t("nav.renameSession")}
          aria-label={t("nav.renameSession")}
          onClick={() => {
            const next = window.prompt(t("nav.renamePrompt"), session.title);
            if (next && next.trim()) onRename(session.id, next.trim());
          }}
        >
          <Icon name="edit" />
        </button>
        <button
          data-testid={`export-${session.id}`}
          title={t("nav.exportSession")}
          aria-label={t("nav.exportSession")}
          onClick={() => onExport(session.id)}
        >
          <Icon name="download" />
        </button>
        <button
          data-testid={`delete-${session.id}`}
          title={native ? t("nav.deleteNativeSession") : t("nav.deleteSession")}
          aria-label={t("nav.deleteSession")}
          onClick={() => onDelete(session.id)}
        >
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

/** 会话列表：搜索 + 按时间分组 + 行操作。 */
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onExport,
}: SessionListProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const filtered = useMemo(() => sessions.filter((s) =>
    resolveSessionDisplayTitle(s).toLowerCase().includes(query.trim().toLowerCase()),
  ), [query, sessions]);
  const grouped = useMemo(() => groupSessionsByTime(filtered), [filtered]);
  const flatSearch = query.trim().length > 0;

  return (
    <section className="session-list flex min-h-0 flex-1 flex-col" data-testid="session-list">
      <div className="session-list-header flex items-center justify-between pb-1 pl-4 pr-[2px] pt-4 text-[12px] font-semibold text-muted-foreground">
        <span>{t("nav.sessionsSection")}</span>
        <button
          type="button"
          className="workbench-search-toggle grid h-[44px] w-[44px] shrink-0 place-items-center rounded-md p-0 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          aria-label={t("nav.searchSessions")}
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((open) => !open)}
        >
          <Icon name="search" size={15} />
        </button>
      </div>
      <input
        className="session-search mx-3 mb-2 h-8 rounded-md border border-border bg-background px-2 text-[13px]"
        data-testid="session-search"
        type="search"
        hidden={!searchOpen}
        placeholder={t("nav.searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={t("nav.searchSessions")}
      />
      {filtered.length === 0 && (
        <div className="empty-hint" data-testid="empty-sessions">
          {t("nav.emptySessions")}
        </div>
      )}
      {flatSearch ? (
        <ul className="session-items">
          {filtered.map((session) => (
            <SessionRow key={session.id} session={session} activeId={activeId} onSelect={onSelect}
              onDelete={onDelete} onRename={onRename} onExport={onExport} t={t} />
          ))}
        </ul>
      ) : (
        grouped.map((group) => (
          <div key={group.key} className="session-group" data-testid={`session-group-${group.key}`}>
            <div className="session-group-label px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(sessionGroupLabelKey[group.key])}</div>
            <ul className="session-items">
              {group.sessions.map((session) => (
                <SessionRow key={session.id} session={session} activeId={activeId} onSelect={onSelect}
                  onDelete={onDelete} onRename={onRename} onExport={onExport} t={t} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
