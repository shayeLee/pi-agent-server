import { Icon } from "./Icon.js";
import { resolveSessionDisplayTitle, type SessionRecord } from "pi-agent-server/client";
import { useI18n } from "../i18n/I18nProvider.js";

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
    <header className="chat-header workbench-chat-header" data-testid="chat-header">
      <div className="workbench-topbar">
        <div className="chat-header-left">
          <span className="session-title-main" data-testid="chat-session-title" title={resolveSessionDisplayTitle(session)}>
            {resolveSessionDisplayTitle(session)}
          </span>
          <nav className="chat-tabs" aria-label="会话视图">
            <button
              className={!traceActive ? "active" : ""}
              data-testid="chat-tab"
              onClick={() => onSelectTab("chat")}
              aria-current={!traceActive ? "page" : undefined}
            >
              {t("chat.tab.chat")}
            </button>
            <button
              className={traceActive ? "active" : ""}
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
            className="btn-ghost btn-icon"
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
