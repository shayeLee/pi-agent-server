import { Icon } from "./Icon.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";
import { useI18n } from "../i18n/I18nProvider.js";
import { cn } from "../lib/utils.js";

export type ChatHeaderProps = {
  session: SessionRecord;
  traceActive: boolean;
  onToggleDetails: () => void;
  onSelectTab: (tab: "chat" | "trace") => void;
};

export function ChatHeader({
  session,
  traceActive,
  onToggleDetails,
  onSelectTab,
}: ChatHeaderProps) {
  const { t } = useI18n();
  return (
    <header className="chat-header workbench-chat-header flex h-12 shrink-0 items-center border-b border-border px-4" data-testid="chat-header">
      <div className="workbench-topbar flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="chat-header-left flex min-w-0 items-center gap-3">
          <span className="session-title-main min-w-0 truncate text-[15px] font-medium" data-testid="chat-session-title" title={resolveSessionDisplayTitle(session)}>
            {resolveSessionDisplayTitle(session)}
          </span>
          <nav className="chat-tabs flex shrink-0 items-center gap-0.5" aria-label="会话视图">
            <button
              className={cn("h-7 rounded-md px-2 text-[13px]", !traceActive ? "active bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}
              data-testid="chat-tab"
              onClick={() => onSelectTab("chat")}
              aria-current={!traceActive ? "page" : undefined}
            >
              {t("chat.tab.chat")}
            </button>
            <button
              className={cn("h-7 rounded-md px-2 text-[13px]", traceActive ? "active bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}
              data-testid="trace-tab"
              onClick={() => onSelectTab("trace")}
              aria-current={traceActive ? "page" : undefined}
            >
              {t("chat.tab.trace")}
            </button>
          </nav>
        </div>
        <div className="header-actions">
          <button
            className="btn-ghost btn-icon grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent max-[639px]:size-[44px]"
            data-testid="toggle-events"
            onClick={onToggleDetails}
            title={traceActive ? t("chat.toggleRunHide") : t("chat.toggleRunShow")}
            aria-label={traceActive ? t("chat.toggleRunHide") : t("chat.toggleRunShow")}
            aria-expanded={traceActive}
          >
            <Icon name="inspector" />
          </button>
        </div>
      </div>
    </header>
  );
}
