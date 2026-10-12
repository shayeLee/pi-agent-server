import { useState, type CSSProperties } from 'react';
import { stepSummary, stepTitles, omissionText } from './step-summary.js';
import { ToolStatusIcon } from './ToolStatusIcon.js';
import type { SessionStep, SessionStepsSnapshot } from '../../../src/shared/session-steps.js';
import { Icon, type IconName } from './Icon.js';
import { imageDataUrl, readMessageImages } from '../message-images.js';

const TYPES: Record<SessionStep['kind'], [string, IconName]> = {
  user: ['用户消息', 'user'], thinking: ['助手思考', 'sparkles'], assistant_text: ['助手消息', 'markdown'],
  tool_call: ['工具调用', 'terminal'], tool_result: ['工具结果', 'file'], notification: ['通知', 'activity'],
  system_event: ['系统事件', 'context'], error: ['错误', 'close'], compaction: ['上下文压缩', 'context'], custom: ['自定义记录', 'file'],
};
function contentText(content: unknown): string {
  if (content === undefined) return '未提供内容';
  if (content === '') return '""（空字符串）';
  if (typeof content === 'string') return content;
  try { return JSON.stringify(content, null, 2) ?? String(content); } catch { return '内容无法序列化'; }
}
// Only interpret the projector's content-block boundaries, never arbitrary nested
// payloads (notably tool arguments). React renders every section as inert text.
function readableContent(content: unknown): { full: string; preview: string } {
  let firstText: string | undefined;
  const blocks = (values: unknown[]): string => values.map(value => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const block = value as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim() && firstText === undefined) firstText = block.text;
        const rest = Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'text'));
        return contentText(block.text) + (Object.keys(rest).length ? `\n${contentText(rest)}` : '');
      }
    }
    return contentText(value);
  }).join('\n\n');
  let full: string;
  if (Array.isArray(content) && content.length) full = blocks(content);
  else if (content && typeof content === 'object' && !Array.isArray(content)
    && Array.isArray((content as Record<string, unknown>).content)) {
    const { content: body, ...metadata } = content as Record<string, unknown>;
    full = (body as unknown[]).length ? blocks(body as unknown[]) : contentText(body);
    if (Object.keys(metadata).length) full += `\n\n${contentText(metadata)}`;
  } else full = contentText(content);
  return { full, preview: firstText ?? full };
}
function Step({ step, index }: { step: SessionStep; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [title, icon]: [string, IconName] = Object.hasOwn(TYPES, step.kind) ? TYPES[step.kind] : [String(step.kind), 'file'];
  const content = step.kind === 'tool_call'
    ? { full: JSON.stringify(step.content, null, 2) ?? contentText(step.content), preview: JSON.stringify(step.content, null, 2) ?? contentText(step.content) }
    : ['user', 'tool_result', 'custom'].includes(step.kind)
      ? readableContent(step.content)
      : { full: contentText(step.content), preview: contentText(step.content) };
  const text = expanded ? content.full : stepSummary(step);
  const semanticTitle = step.kind === 'system_event' && Object.hasOwn(stepTitles, step.label ?? '') ? stepTitles[step.label!] : undefined;
  return <li className={`session-step session-step-${step.kind}`} data-testid="session-step" data-step-id={step.id} data-status={step.status}>
    <span className="step-number">{index + 1}</span>
    <span className="step-icon"><Icon name={icon} size={18} /></span>
    <div className="step-main">
      <button type="button" className="step-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="step-heading"><strong>{semanticTitle ?? title}</strong>{step.omission !== undefined && <span className="step-omission-marker" title="内容有安全投影或来源限制，展开查看说明" aria-label="内容限制说明">*</span>}{step.toolName !== undefined && <span className="step-tool-name">{step.toolName}</span>}{step.label !== undefined && !semanticTitle && <span className="step-label">{step.label}</span>}</span>
        {step.timestamp && <time dateTime={step.timestamp} title={`${step.source === 'recorded' ? '记录时间' : '首次观察时间'}：${step.timestamp}`}>{/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(step.timestamp) ? step.timestamp.slice(11, 19) : step.timestamp}</time>}
        <Icon name={expanded ? 'down' : 'chevron'} size={12} />
      </button>
      <div className={`step-content ${expanded ? 'expanded' : 'collapsed'}`}>
        {step.kind === 'tool_result' && (step.status === 'completed' || step.status === 'error' || step.status === 'streaming') && <ToolStatusIcon done={step.status !== 'streaming'} isError={step.status === 'error'} />}
        <pre>{text}</pre>
        {expanded && readMessageImages(step.images).map((image, i) => <img key={i} className="step-image" src={imageDataUrl(image)} alt={`步骤 ${index + 1} 图片 ${i + 1}`} />)}
      </div>
      {expanded && step.omission !== undefined && <p className="step-note">{omissionText(step.omission)}</p>}
      {step.status !== 'completed' && <span className="step-status">{({ streaming: '进行中', error: '错误', aborted: '已中止', unknown: '状态未知' } as const)[step.status] ?? step.status}</span>}
    </div>
  </li>;
}
export function SessionSteps({ sessionSelected, snapshot, loading, error }: {
  sessionSelected: boolean; snapshot?: SessionStepsSnapshot | null; loading?: boolean; error?: string | null;
}) {
  if (!sessionSelected) return <div className="empty-hint">未选择会话</div>;
  return <div className="session-steps" data-testid="session-steps" aria-busy={loading}>
    {loading && <p className="step-note" role="status">正在加载步骤…</p>}
    {error && <p className="step-note" role="alert">步骤加载失败：{error}{snapshot ? '（保留上次快照）' : ''}</p>}
    {!loading && !error && !snapshot?.steps.length && <div className="empty-hint">暂无步骤</div>}
    <ol className="steps-list" style={{ '--step-number-width': `max(22px, calc(${String(snapshot?.steps.length ?? 0).length}ch + 10px))` } as CSSProperties} key={`${snapshot?.sessionId}:${snapshot?.projectionId}`}>
      {snapshot?.steps.map((step, index) => <Step key={step.id} step={step} index={index} />)}
    </ol>
  </div>;
}
