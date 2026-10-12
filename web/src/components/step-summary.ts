import type { SessionStep } from '../../../src/shared/session-steps.js';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scalar = (value: unknown): string | undefined => value === null ? 'null' : typeof value === 'string' ? value || '""（空字符串）' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
function body(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (Array.isArray(value)) return value.map(block => {
    const b = object(block);
    return b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'thinking' && typeof b.thinking === 'string' ? b.thinking : '';
  }).find(text => text.trim()) || undefined;
  return undefined;
}
export const stepTitles: Record<string, string> = { model_change: '模型变更', thinking_level_change: '思考级别变更', system: '系统提示词记录' };
/** Interpret only known DTO boundaries; never search arbitrary nested metadata for a plausible value. */
export function stepSummary(step: SessionStep): string {
  if (step.content === undefined) return '未提供内容';
  const c = object(step.content);
  if (step.kind === 'system_event' && step.label === 'model_change') {
    const values = ['provider', 'modelId'].filter(key => Object.hasOwn(c, key)).map(key => scalar(c[key])).filter(value => value !== undefined);
    return values.join(' / ') || '模型变更记录（展开查看）';
  }
  if (step.kind === 'system_event' && step.label === 'thinking_level_change') return Object.hasOwn(c, 'thinkingLevel') ? scalar(c.thinkingLevel) ?? '思考级别记录（展开查看）' : '思考级别记录（展开查看）';
  if (step.kind === 'tool_call') {
    const values = ['command', 'path', 'task', 'query'].filter(key => Object.hasOwn(c, key)).map(key => scalar(c[key])).filter(value => value !== undefined);
    return values.join(' · ') || (scalar(step.content) ?? '工具输入（展开查看）');
  }
  const text = body(step.content) ?? body(c.content);
  if (text) return text;
  if (step.kind === 'system_event' && step.label === 'system') {
    // SystemMessage.sections is a named Record<string, string | null>, not arbitrary nested metadata.
    const section = Object.entries(object(c.sections)).find(([, value]) => typeof value === 'string' && value.trim());
    return section ? `${section[0]}：${section[1]}` : '系统提示词记录（展开查看内容与分节）';
  }
  for (const key of ['summary', 'message', 'text', 'reason', 'errorMessage']) {
    if (typeof c[key] === 'string' && c[key].trim()) return c[key];
  }
  return scalar(step.content) ?? '结构化记录（展开查看）';
}
const omissions: Record<string, string> = {
  'Only public entry fields shown; extension state omitted': '仅展示公开记录字段；扩展内部状态未公开。',
  'Unknown content represented safely': '未知内容已按安全方式呈现。',
  'Thinking redacted by source': '来源已遮蔽思考内容。',
  'Provider signature omitted': '已省略提供方签名。',
  'Source has no visible content blocks': '来源没有可见内容块。',
  'Unknown message role; only safe content is shown': '未知消息角色；仅展示安全内容。',
  'Source output is truncated; fullOutputPath is not read': '来源输出已截断；未读取 fullOutputPath。',
  'Image binary omitted from content; only validated images are attached': '正文省略图片二进制；仅附加已验证图片。',
  'Images omitted by existing export safety budget': '部分图片因既有导出安全限额而省略。',
  'Extension details and system replay checkpoint are not public step content': '扩展详情和系统重放检查点不属于公开步骤内容。',
};
export function omissionText(value: string): string {
  return Object.hasOwn(omissions, value) ? omissions[value] : value.split('; ').map(part => Object.hasOwn(omissions, part) ? omissions[part] : part).join('; ');
}
