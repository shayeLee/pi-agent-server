import type { SessionRecord } from 'pi-agent-server/client';
import type { SessionSystemPrompt } from '../../../src/shared/system-prompt.js';

export type SystemPromptPanelProps = {
  session: SessionRecord | null;
  systemPrompt?: SessionSystemPrompt | null;
  loading?: boolean;
  error?: string | null;
};
export function SystemPromptPanel({ session, systemPrompt, loading, error }: SystemPromptPanelProps) {
  if (!session) return <div className="empty-hint">未选择会话</div>;
  if (loading) return <div className="empty-hint" role="status">正在加载系统提示词…</div>;
  if (error) return <div className="empty-hint" role="alert">系统提示词加载失败：{error}</div>;
  if (!systemPrompt || systemPrompt.source === 'unavailable') return <div className="empty-hint">系统提示词不可用</div>;
  return <div className="system-prompt-panel" data-testid="system-prompt-panel">
    {systemPrompt.source === 'creation_snapshot' && <p className="steps-provenance">创建时快照 · 不是实时运行值</p>}
    {systemPrompt.prompt === '' && <p className="step-note">空字符串（有效提示词）</p>}
    <pre className="system-prompt-text">{systemPrompt.prompt}</pre>
  </div>;
}
