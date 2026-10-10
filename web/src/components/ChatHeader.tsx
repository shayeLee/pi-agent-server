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
    "chat-tab px-2 text-[13px] leading-none",
    active ? "active text-foreground" : "text-muted-foreground",
  );
  return (
    <header className="chat-header workbench-chat-header flex h-12 shrink-0 items-center border-b border-border px-4 max-[1179px]:pl-14" data-testid="chat-header">
      <div className="workbench-topbar flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="chat-header-left flex min-w-0 items-center gap-3">
          <span className="session-title-main min-w-0 truncate text-[18px] font-semibold leading-none" data-testid="chat-session-title" title={resolveSessionDisplayTitle(session)}>
            {resolveSessionDisplayTitle(session)}
          </span>
          <nav className="chat-tabs hidden" aria-label={t("chat.view")}>
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
        <div className="header-actions">
          <button
            className="btn-ghost btn-icon grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-[639px]:size-[44px]"
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
