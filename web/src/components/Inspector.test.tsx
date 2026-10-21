import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { SessionRecord } from 'pi-agent-server/client';
import type { SessionStep, SessionStepsSnapshot } from '../../../src/shared/session-steps.js';
import { Inspector } from './Inspector.js';
const session = { id: 's' } as SessionRecord;
const step = (id: string, content: unknown, kind: SessionStep['kind'] = 'assistant_text'): SessionStep => ({ id, content, kind, status: 'completed', source: 'recorded' });
const snapshot = (steps: SessionStep[], projectionId = 'p'): SessionStepsSnapshot => ({ sessionId: 's', projectionId, revision: 1, steps });
const base = { session, entries: [], onClearEvents: vi.fn() };
describe('Inspector steps', () => {
 it('preserves full array order and count including thinking, calls and parallel results', () => {
  const rows = [step('u', 'hello', 'user'), step('t', 'think', 'thinking'), {...step('a', {count: 0}, 'tool_call'), toolName: 'subagent_wait'}, step('b', 'B result', 'tool_result'), step('c', 'A result', 'tool_result')];
  render(<Inspector {...base} steps={snapshot(rows)} />);
  expect(screen.getByRole('tab', {name: '步骤 5'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.getAllByTestId('session-step').map(el => el.dataset.stepId)).toEqual(['u','t','a','b','c']);
  expect(screen.getByText('subagent_wait')).toBeVisible();
 });
 it('retains expanded identity through streaming updates but resets projection and session', () => {
  const { rerender } = render(<Inspector {...base} steps={snapshot([step('a', 'first'.repeat(40))])} />);
  fireEvent.click(screen.getByRole('button', {name: '助手消息'}));
  const full = 'stream '.repeat(5000) + 'FINAL';
  rerender(<Inspector {...base} steps={snapshot([step('a', full)])} />);
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('dialog')).toHaveTextContent('FINAL');
  rerender(<Inspector {...base} steps={snapshot([step('a', full)], 'new')} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(<Inspector {...base} session={{id:'other'} as SessionRecord} steps={snapshot([step('a', full)])} />);
  expect(screen.queryByText(full)).toBeNull();
  expect(screen.getByRole('tab', {name: '步骤 0'})).toBeVisible();
 });
 it('renders missing, empty, null, false, zero and unknown safely without remote images or HTML', () => {
  render(<Inspector {...base} steps={snapshot([step('1', undefined), step('2', ''), step('3', null), step('4', false), step('5', 0), {...step('6', '<script>unsafe</script>', 'custom'), images: [{mediaType:'image/svg+xml',base64:'abcd'}]}, step('7', {}, 'constructor' as SessionStep['kind'])])} />);
  for (const value of ['未提供内容', '""（空字符串）', 'null', 'false', '0', '<script>unsafe</script>', 'constructor']) expect(screen.getByText(value)).toBeVisible();
  expect(document.querySelector('script,img')).toBeNull();
 });
 it('keeps saved snapshot on errors, uses supplied timestamps only and does not sort', () => {
  render(<Inspector {...base} stepsError="offline" steps={snapshot([
   {...step('first', 'same'), timestamp:'2026-06-01T12:00:00Z', source:'observed'},
   {...step('second', 'same'), timestamp:'2026-06-01T10:00:00Z'}, step('third', 'no time'),
  ])} />);
  expect(screen.getAllByTestId('session-step').map(el => el.dataset.stepId)).toEqual(['first','second','third']);
  expect(screen.getAllByText('same')).toHaveLength(2);
  expect(document.querySelectorAll('time')).toHaveLength(2);
  expect(screen.getByTitle('首次观察时间：2026-06-01T12:00:00Z')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('保留上次快照');
 });
 it('preserves event details, local filtering and clear callback', () => {
  const clear = vi.fn();
  render(<Inspector {...base} activeTab="events" onClearEvents={clear} entries={[
   {seq:1, type:'text_delta',time:'10:00',data:'text'}, {seq:2,type:'error',time:'10:01',data:{message:'failure'}},
  ]} />);
  fireEvent.click(screen.getByTestId('event-filter'));
  fireEvent.click(screen.getByRole('option', {name:'error'}));
  expect(screen.queryByTestId('event-1')).toBeNull();
  expect(screen.getByTestId('event-2').querySelector('summary')).toBeVisible();
  fireEvent.click(screen.getByTestId('event-clear'));
  expect(clear).toHaveBeenCalledOnce();
 });
 it('supports controlled tabs, keyboard navigation, close and honest loading/error states', () => {
  const change = vi.fn(), close = vi.fn();
  const { rerender } = render(<Inspector {...base} onTabChange={change} onClose={close} stepsLoading />);
  expect(screen.getByRole('status')).toHaveTextContent('正在加载');
  fireEvent.keyDown(screen.getByRole('tab', {name: '步骤 0'}), {key:'ArrowRight'});
  expect(change).toHaveBeenCalledWith('systemPrompt');
  fireEvent.keyDown(screen.getByTestId('inspector'), {key:'Escape'});
  expect(close).toHaveBeenCalledOnce();
  rerender(<Inspector {...base} activeTab="steps" stepsError="offline" />);
  expect(screen.getByRole('alert')).toHaveTextContent('offline');
  fireEvent.click(screen.getByRole('tab', {name:'事件流'}));
  expect(screen.getByRole('tab', {name:'步骤 0'})).toHaveAttribute('aria-selected','true');
 });
});

it('keeps the directory open when Escape is pressed inside step details', () => {
  const close = vi.fn();
  render(<Inspector {...base} onClose={close} steps={snapshot([step('long', 'detail '.repeat(50), 'system_event')])} />);
  fireEvent.click(screen.getByRole('button', {name:'系统事件'}));
  fireEvent.keyDown(screen.getByRole('dialog'), {key:'Escape'});
  expect(close).not.toHaveBeenCalled();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', {bubbles:false, cancelable:true}));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByTestId('session-steps')).toBeVisible();
});
