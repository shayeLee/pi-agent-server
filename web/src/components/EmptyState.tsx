import { useI18n } from "../i18n/I18nProvider.js";

/** 空历史（已有会话且确认历史为空）：单行次要文字，与起始态文案/位置可区分。 */
export function EmptyState() {
  const { t } = useI18n();
  return (
    <p className="chat-empty-history" data-testid="chat-empty">
      {t("chat.emptyHistory")}
    </p>
  );
}
