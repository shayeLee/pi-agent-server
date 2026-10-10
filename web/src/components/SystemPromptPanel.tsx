import type { SessionRecord } from "pi-agent-server/client";
import { useI18n } from "../i18n/I18nProvider.js";

export type SystemPromptPanelProps = {
  session: SessionRecord | null;
};

export function SystemPromptPanel({ session }: SystemPromptPanelProps) {
  const { t } = useI18n();
  if (!session) {
    return <div className="empty-hint">{t("inspector.noSession")}</div>;
  }
  if (!session.systemPrompt) {
    return <div className="empty-hint">{t("inspector.noSystemPrompt")}</div>;
  }
  return (
    <div className="system-prompt-panel" data-testid="system-prompt-panel">
      <pre className="system-prompt-text">{session.systemPrompt}</pre>
    </div>
  );
}
