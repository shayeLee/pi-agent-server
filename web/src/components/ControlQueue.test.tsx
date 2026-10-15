import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ControlQueue } from './ControlQueue.js';
it('counts only authoritative rows, promotes only followUp and waits for a new snapshot', () => {
  const props = {items:[{id:'a',kind:'steer' as const,text:'A'},{id:'b',kind:'followUp' as const,text:'B'}],onDelete:vi.fn(),onPromote:vi.fn()};
  const view = render(<ControlQueue {...props} />);
  expect(within(screen.getByRole('region',{name:'引导队列'})).queryByRole('button',{name:/引导：/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'引导：B'})); expect(props.onPromote).toHaveBeenCalledWith('b');
  fireEvent.click(screen.getByRole('button',{name:'删除：A'})); expect(props.onDelete).toHaveBeenCalledWith('a');
  expect(screen.getAllByTestId('control-queue-item')).toHaveLength(2);
  view.rerender(<ControlQueue {...props} items={[]} />); expect(screen.queryByTestId('control-queue-item')).toBeNull();
  expect(screen.queryByTestId('control-queue')).toBeNull();
});
it('renders Ledger text actions without decorative icons (DESIGN.md §5.5)', () => {
  render(<ControlQueue items={[{id:'a',kind:'steer',text:'A'},{id:'b',kind:'followUp',text:'B'}]} onDelete={vi.fn()} onPromote={vi.fn()} />);
  expect(screen.getByTestId('control-queue').querySelector('svg')).toBeNull();
  expect(screen.getByRole('button',{name:'引导：B'})).toHaveTextContent('↑ 改为引导');
  expect(screen.getByRole('button',{name:'删除：A'})).toHaveTextContent('删除');
  expect(screen.getByLabelText('第 1 条')).toHaveTextContent('01');
});
it('unknown is refresh-only, failure stays actionable', () => {
  const refresh = vi.fn(); const props = {items:[{id:'a',kind:'followUp' as const,text:'A'}],onDelete:vi.fn(),onPromote:vi.fn(),onRefresh:refresh};
  const view = render(<ControlQueue {...props} operations={{a:{status:'unknown'}}} />);
  expect(screen.getByRole('button',{name:'删除：A'})).toBeDisabled(); expect(screen.getByRole('button',{name:'引导：A'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'刷新队列确认结果'})); expect(refresh).toHaveBeenCalledOnce();
  view.rerender(<ControlQueue {...props} operations={{a:{status:'failed',error:'冲突'}}} />);
  expect(screen.getByText('冲突')).toBeVisible(); expect(screen.getByRole('button',{name:'删除：A'})).toBeEnabled();
});
it('renders each message with its own queue label, position and actions', () => {
  render(<ControlQueue items={[{id:'a',kind:'steer',text:'A'},{id:'b',kind:'followUp',text:'B'},{id:'c',kind:'followUp',text:'C'}]} onDelete={vi.fn()} onPromote={vi.fn()} />);
  const rows = screen.getAllByTestId('control-queue-item');
  rows.forEach((row, index) => {
    expect(within(row).getByText(index === 0 ? '引导队列' : '追加队列')).toBeVisible();
    expect(within(row).getByLabelText(`第 ${index + 1} 条`)).toBeVisible();
    expect(within(row).getByRole('button', {name:`删除：${['A','B','C'][index]}`})).toBeEnabled();
  });
  expect(within(rows[1]).getByRole('button', {name:'引导：B'})).toBeEnabled();
  expect(within(rows[2]).getByRole('button', {name:'引导：C'})).toBeEnabled();
});
