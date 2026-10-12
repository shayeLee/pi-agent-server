import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { SessionRecord } from 'pi-agent-server/client';
import { SystemPromptPanel } from './SystemPromptPanel.js';
const session = { id: 's', systemPrompt: 'old creation value' } as SessionRecord;
describe('SystemPromptPanel provenance', () => {
 it('shows full live value without claiming sent, and marks creation snapshots', () => {
  const prompt = 'FULL\n'.repeat(10000);
  const {rerender, container} = render(<SystemPromptPanel session={session} systemPrompt={{source:'live_effective',prompt}} />);
  expect(screen.queryByText('当前有效提示词 · 不代表已发送给模型')).toBeNull();
  expect(container.querySelector('pre')?.textContent).toBe(prompt);
  rerender(<SystemPromptPanel session={session} systemPrompt={{source:'creation_snapshot',prompt:'creation'}} />);
  expect(screen.getByText('创建时快照 · 不是实时运行值')).toBeVisible();
 });
 it('distinguishes empty/unavailable and hides stale values during loading or error', () => {
  const value = {source:'live_effective' as const,prompt:'stale'};
  const {rerender} = render(<SystemPromptPanel session={session} systemPrompt={value} loading />);
  expect(screen.queryByText('stale')).toBeNull();
  rerender(<SystemPromptPanel session={session} systemPrompt={value} error="offline" />);
  expect(screen.getByRole('alert')).toHaveTextContent('offline');
  expect(screen.queryByText('stale')).toBeNull();
  rerender(<SystemPromptPanel session={session} systemPrompt={{source:'live_effective',prompt:''}} />);
  expect(screen.getByText('空字符串（有效提示词）')).toBeVisible();
  rerender(<SystemPromptPanel session={session} systemPrompt={{source:'unavailable',prompt:null}} />);
  expect(screen.getByText('系统提示词不可用')).toBeVisible();
  expect(screen.queryByText(session.systemPrompt!)).toBeNull();
 });
});
