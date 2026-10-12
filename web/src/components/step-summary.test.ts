import { describe, it, expect } from 'vitest';
import { stepSummary, omissionText } from './step-summary';
import type { SessionStep } from '../../../src/shared/session-steps';
const step = (content: unknown, label?: string, kind: SessionStep['kind'] = 'system_event'): SessionStep => ({ id: 's', content, label, kind, status: 'completed', source: 'recorded' });
describe('safe DTO summaries', () => {
  it('reads exact model/level fields, not guessed nested values', () => {
    expect(stepSummary(step({ type: 'model_change', provider: 'openai', modelId: 'gpt-5.5' }, 'model_change'))).toBe('openai / gpt-5.5');
    expect(stepSummary(step({ thinkingLevel: 'medium' }, 'thinking_level_change'))).toBe('medium');
    expect(stepSummary(step({ nested: { modelId: 'NOT_REAL' } }, 'model_change'))).toBe('模型变更记录（展开查看）');
    for (const value of [null, false, 0, '']) expect(stepSummary(step({ thinkingLevel: value }, 'thinking_level_change'))).toBe(value === '' ? '""（空字符串）' : String(value));
  });
  it('uses safe body text and generic fallbacks, never JSON braces', () => {
    expect(stepSummary(step({ content: '', sections: [{ content: 'not guessed' }] }, 'system'))).toBe('系统提示词记录（展开查看内容与分节）');
    expect(stepSummary(step({ content: '真实系统正文', sections: {} }, 'system'))).toBe('真实系统正文');
    expect(stepSummary(step({ content: '', sections: { removed: null, empty: '', instructions: '真实分节' } }, 'system'))).toBe('instructions：真实分节');
    expect(stepSummary(step({ content: [{ type: 'text', text: '正文' }], details: { text: 'not body' } }, undefined, 'tool_result'))).toBe('正文');
    expect(stepSummary(step({ unknown: 0 }))).toBe('结构化记录（展开查看）');
    expect(stepSummary(step({ command: 'pwd', unknown: false }, undefined, 'tool_call'))).toBe('pwd');
    expect(stepSummary(step({ message: '安全通知' }, undefined, 'notification'))).toBe('安全通知');
  });
  it('translates only known omission reasons', () => {
    expect(omissionText('Provider signature omitted; Thinking redacted by source')).toBe('已省略提供方签名。; 来源已遮蔽思考内容。');
    expect(omissionText('Unknown future reason: 0 false; preserve punctuation')).toBe('Unknown future reason: 0 false; preserve punctuation');
  });
});
