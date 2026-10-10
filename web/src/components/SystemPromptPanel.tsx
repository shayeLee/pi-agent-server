import type { SessionRecord } from "pi-agent-server/client";
import { useI18n } from "../i18n/I18nProvider.js";

export type SystemPromptPanelProps = {
  session: SessionRecord | null;
};

export function SystemPromptPanel({ session }: SystemPromptPanelProps) {
  const { t } = useI18n();
  if (!session) {
    return <div className="empty-hint px-3 py-6 text-center text-[13px] text-muted-foreground">{t("inspector.noSession")}</div>;
  }
  if (!session.systemPrompt) {
    return <div className="empty-hint px-3 py-6 text-center text-[13px] text-muted-foreground">{t("inspector.noSystemPrompt")}</div>;
  }
  return (
    <div className="system-prompt-panel p-3" data-testid="system-prompt-panel">
      <pre className="system-prompt-text overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed">{session.systemPrompt}</pre>
    </div>
  );
}
