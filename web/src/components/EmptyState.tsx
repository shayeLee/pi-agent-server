import { zhCN } from "../i18n/zh-CN.js";
/** 空历史（已有会话且确认历史为空）：单行次要文字，与起始态文案/位置可区分。 */
export function EmptyState() {
  return (
    <p className="chat-empty-history" data-testid="chat-empty">
      {zhCN.systemPrompt.emptyHistory}</p>
  );
}
