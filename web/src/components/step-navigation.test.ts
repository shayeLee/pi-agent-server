import { afterEach, expect, it } from 'vitest';
import { stepTarget } from './step-navigation.js';
import type { SessionStep } from '../../../src/shared/session-steps.js';
const step = (id: string, kind: SessionStep['kind'], extra: Partial<SessionStep> = {}): SessionStep => ({id, kind, content:'same', status:'completed', source:'observed', ...extra});
function row(id: string, kind: string, tool?: string) {
  const element = document.createElement('div');
  element.dataset.timelineId = id; element.dataset.timelineKind = kind;
  if (tool) element.dataset.toolCallId = tool;
  document.body.append(element);
  return element;
}
afterEach(() => { document.body.innerHTML = ''; });
it('maps tool call and result to the same card, excluding nested tool calls', () => {
  const target = row('tool', 'tool_call', 'call');
  expect(stepTarget(step('call', 'tool_call', {toolCallId:'call'}))).toBe(target);
  expect(stepTarget(step('result', 'tool_result', {toolCallId:'call'}))).toBe(target);
  expect(stepTarget(step('nested', 'tool_call', {toolCallId:'call', parentToolCallId:'parent'}))).toBeUndefined();
});
it('keeps repeated live messages separate and refuses inconsistent sequences', () => {
  const first = row('confirmed-one', 'user');
  row('assistant-1', 'assistant_text');
  const second = row('confirmed-two', 'user');
  const steps = [step('one', 'user'), step('answer', 'assistant_text'), step('two', 'user')];
  expect(stepTarget(steps[0], steps)).toBe(first);
  expect(stepTarget(steps[2], steps)).toBe(second);
  expect(stepTarget(steps[2], [...steps, step('missing', 'assistant_text')])).toBeUndefined();
});
it('does not map empty thinking to a blank chat location', () => {
  row('history-message:one', 'user');
  const target = row('assistant-1', 'assistant_text');
  const steps = [step('entry:one', 'user', {sourceEntryId:'one'}), step('thought', 'thinking', {content:''}), step('answer', 'assistant_text')];
  expect(stepTarget(steps[2], steps)).toBe(target);
  expect(stepTarget(steps[1], steps)).toBeUndefined();
});
