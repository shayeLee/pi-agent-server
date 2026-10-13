import { zhCN } from "../i18n/zh-CN.js";
import type { SessionStep } from '../../../src/shared/session-steps.js';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scalar = (value: unknown): string | undefined => value === null ? 'null' : typeof value === 'string' ? value || zhCN.steps.emptyString : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
function body(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (Array.isArray(value)) return value.map(block => {
    const b = object(block);
    return b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'thinking' && typeof b.thinking === 'string' ? b.thinking : '';
  }).find(text => text.trim()) || undefined;
  return undefined;
}
export const stepTitles: Record<string, string> = { model_change: zhCN.stepSummary.modelChange, thinking_level_change: zhCN.stepSummary.thinkingChange, system: zhCN.stepSummary.systemPrompt };
/** Interpret only known DTO boundaries; never search arbitrary nested metadata for a plausible value. */
export function stepSummary(step: SessionStep): string {
  if (step.content === undefined) return zhCN.steps.missingContent;
  const c = object(step.content);
  if (step.kind === 'system_event' && step.label === 'model_change') {
    const values = ['provider', 'modelId'].filter(key => Object.hasOwn(c, key)).map(key => scalar(c[key])).filter(value => value !== undefined);
    return values.join(' / ') || zhCN.stepSummary.modelDetails;
  }
  if (step.kind === 'system_event' && step.label === 'thinking_level_change') return Object.hasOwn(c, 'thinkingLevel') ? scalar(c.thinkingLevel) ?? zhCN.stepSummary.thinkingDetails : zhCN.stepSummary.thinkingDetails;
  if (step.kind === 'tool_call') {
    const values = ['command', 'path', 'task', 'query'].filter(key => Object.hasOwn(c, key)).map(key => scalar(c[key])).filter(value => value !== undefined);
    return values.join(' · ') || (scalar(step.content) ?? zhCN.stepSummary.toolInput);
  }
  const text = body(step.content) ?? body(c.content);
  if (text) return text;
  if (step.kind === 'system_event' && step.label === 'system') {
    // SystemMessage.sections is a named Record<string, string | null>, not arbitrary nested metadata.
    const section = Object.entries(object(c.sections)).find(([, value]) => typeof value === 'string' && value.trim());
    return section ? `${section[0]}：${section[1]}` : zhCN.stepSummary.systemPromptDetails;
  }
  for (const key of ['summary', 'message', 'text', 'reason', 'errorMessage']) {
    if (typeof c[key] === 'string' && c[key].trim()) return c[key];
  }
  return scalar(step.content) ?? zhCN.stepSummary.structuredDetails;
}
const omissions: Record<string, string> = {
  'Only public entry fields shown; extension state omitted': zhCN.stepSummary.publicOnly,
  'Unknown content represented safely': zhCN.stepSummary.unknownContent,
  'Thinking redacted by source': zhCN.stepSummary.thinkingRedacted,
  'Provider signature omitted': zhCN.stepSummary.signatureOmitted,
  'Source has no visible content blocks': zhCN.stepSummary.emptyContent,
  'Unknown message role; only safe content is shown': zhCN.stepSummary.unknownRole,
  'Source output is truncated; fullOutputPath is not read': zhCN.stepSummary.truncatedOutput,
  'Image binary omitted from content; only validated images are attached': zhCN.stepSummary.imagesOmitted,
  'Images omitted by existing export safety budget': zhCN.stepSummary.imageLimits,
  'Extension details and system replay checkpoint are not public step content': zhCN.stepSummary.privateDetails,
};
export function omissionText(value: string): string {
  return Object.hasOwn(omissions, value) ? omissions[value] : value.split('; ').map(part => Object.hasOwn(omissions, part) ? omissions[part] : part).join('; ');
}
