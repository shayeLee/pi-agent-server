import { zhCN } from "../i18n/zh-CN.js";
import type { SessionRecord } from 'pi-agent-server/client';
import type { SessionSystemPrompt } from '../../../src/shared/system-prompt.js';

export type SystemPromptPanelProps = {
  session: SessionRecord | null;
  systemPrompt?: SessionSystemPrompt | null;
  loading?: boolean;
  error?: string | null;
};
export function SystemPromptPanel({ session, systemPrompt, loading, error }: SystemPromptPanelProps) {
  if (!session) return <div className="empty-hint">{zhCN.systemPrompt.noSession}</div>;
  if (loading) return <div className="empty-hint" role="status">{zhCN.systemPrompt.loading}</div>;
  if (error) return <div className="empty-hint" role="alert">{zhCN.systemPrompt.loadFailed}{error}</div>;
  if (!systemPrompt || systemPrompt.source === 'unavailable') return <div className="empty-hint">{zhCN.systemPrompt.unavailable}</div>;
  return <div className="system-prompt-panel" data-testid="system-prompt-panel">
    {systemPrompt.source === 'creation_snapshot' && <p className="steps-provenance">{zhCN.systemPrompt.creationSnapshot}</p>}
    {systemPrompt.prompt === '' && <p className="step-note">{zhCN.systemPrompt.emptyString}</p>}
    <pre className="system-prompt-text">{systemPrompt.prompt}</pre>
  </div>;
}
