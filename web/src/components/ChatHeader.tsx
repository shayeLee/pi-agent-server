import { Icon } from "./Icon.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";
import { useI18n } from "../i18n/I18nProvider.js";
import { cn } from "../lib/utils.js";

export type ChatHeaderProps = {
  session: SessionRecord;
  traceActive: boolean;
  toolCount?: number;
  onToggleDetails: () => void;
  onSelectTab: (tab: "chat" | "trace") => void;
};

export function ChatHeader({
  session,
  traceActive,
  toolCount = 0,
  onToggleDetails,
  onSelectTab,
}: ChatHeaderProps) {
  const { t } = useI18n();
  const panelLabel = traceActive ? t("chat.toggleRunHide") : t("chat.toggleRunShow");
  const tabClass = (active: boolean) => cn(
    "chat-tab -mb-px border-b-2 px-2 pb-2.5 pt-3 text-[13px] leading-none",
    active ? "active border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
  );
  return (
    <header className="chat-header workbench-chat-header flex h-12 shrink-0 items-end border-b border-border px-4" data-testid="chat-header">
      <div className="workbench-topbar flex min-w-0 flex-1 items-end justify-between gap-3">
        <div className="chat-header-left flex min-w-0 items-end gap-3">
          <span className="session-title-main mb-2.5 min-w-0 truncate text-[15px] font-medium leading-none" data-testid="chat-session-title" title={resolveSessionDisplayTitle(session)}>
            {resolveSessionDisplayTitle(session)}
          </span>
          <nav className="chat-tabs flex shrink-0 items-end" aria-label={t("chat.view")}>
            <button
              className={tabClass(!traceActive)}
              data-testid="chat-tab"
              onClick={() => onSelectTab("chat")}
              aria-current={!traceActive ? "page" : undefined}
            >
              {t("chat.tab.chat")}
            </button>
            <button
              className={tabClass(traceActive)}
              data-testid="trace-tab"
              onClick={() => onSelectTab("trace")}
              aria-current={traceActive ? "page" : undefined}
            >
              {t("chat.tab.trace")}
              {toolCount > 0 && (
                <span
                  className="chat-tab-count ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums text-primary"
                  data-testid="stat-steps"
                  title={t("chat.toolCount", { count: String(toolCount) })}
                >
                  {toolCount}
                </span>
              )}
            </button>
          </nav>
        </div>
        <div className="header-actions mb-1.5">
          <button
            className="btn-ghost btn-icon grid size-8 place-items-center rounded-md text-foreground hover:bg-accent max-[639px]:size-[44px]"
            data-testid="toggle-events"
            onClick={onToggleDetails}
            title={panelLabel}
            aria-label={panelLabel}
            aria-expanded={traceActive}
          >
            <Icon name="inspector" />
          </button>
        </div>
      </div>
    </header>
  );
}
