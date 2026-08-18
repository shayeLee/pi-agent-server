import type { SessionRecord } from "../types.js";

export type SystemPromptPanelProps = {
  session: SessionRecord | null;
};

export function SystemPromptPanel({ session }: SystemPromptPanelProps) {
  if (!session) {
    return <div className="empty-hint">未选择会话</div>;
  }
  if (!session.systemPrompt) {
    return <div className="empty-hint">当前会话未记录系统提示词</div>;
  }
  return (
    <div className="system-prompt-panel" data-testid="system-prompt-panel">
      <pre className="system-prompt-text">{session.systemPrompt}</pre>
    </div>
  );
}
