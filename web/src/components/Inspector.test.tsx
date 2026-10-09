import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Inspector } from './Inspector.js';
describe('Inspector tool list', () => {
 it('uses actual summaries, complete names and call status without inventing actions or child state', () => {
  render(<Inspector session={null} entries={[]} onClearEvents={() => {}} timeline={[
   {kind: 'tool', id: 'wait', call: {toolCallId: 'wait', toolName: 'subagent_wait', args: {runIds: [1]}, partialResult: undefined, result: 'child still running', done: true, isError: false}},
   {kind: 'tool', id: 'custom', call: {toolCallId: 'custom', toolName: 'custom_'.repeat(30), args: {count: 0}, partialResult: undefined, result: undefined, done: false, isError: false}},
  ]} />);
  fireEvent.click(screen.getByTestId('inspector-tab-tools'));
  expect(screen.getByText('subagent_wait')).toBeVisible();
  expect(screen.getByText('runIds=[1] · child still running')).toBeVisible();
  expect(screen.getByText('custom_'.repeat(30))).toBeVisible();
  expect(screen.getByRole('img', {name: '已完成'})).toBeInTheDocument();
  expect(screen.getByRole('img', {name: '进行中'})).toBeInTheDocument();
  expect(screen.getByTestId('inspector-tools').querySelector('button')).toBeNull();
  expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('tabindex', '0');
 });
 it('keeps the empty state honest', () => {
  render(<Inspector session={null} entries={[]} timeline={[]} onClearEvents={() => {}} />);
  fireEvent.click(screen.getByTestId('inspector-tab-tools'));
  expect(screen.getByText('暂无工具调用')).toBeVisible();
 });
});
