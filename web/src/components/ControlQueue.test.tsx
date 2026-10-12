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
it('uses a dedicated paper plane for steering and preserves the follow-up clock', () => {
  render(<ControlQueue items={[{id:'a',kind:'steer',text:'A'},{id:'b',kind:'followUp',text:'B'}]} onDelete={vi.fn()} onPromote={vi.fn()} />);
  const steer = screen.getByRole('region', {name:'引导队列'});
  const followUp = screen.getByRole('region', {name:'追加队列'});
  expect(steer.querySelector('header svg')).toHaveAttribute('data-icon', 'paper-plane');
  expect(steer.querySelector('header svg')).toHaveAttribute('width', '20');
  expect(steer.querySelector('[data-icon="send"]')).toBeNull();
  expect(followUp.querySelector('header svg')).toHaveAttribute('data-icon', 'clock');
  expect(followUp.querySelector('header svg')).toHaveAttribute('width', '16');
});
it('unknown is refresh-only, failure stays actionable', () => {
  const refresh = vi.fn(); const props = {items:[{id:'a',kind:'followUp' as const,text:'A'}],onDelete:vi.fn(),onPromote:vi.fn(),onRefresh:refresh};
  const view = render(<ControlQueue {...props} operations={{a:{status:'unknown'}}} />);
  expect(screen.getByRole('button',{name:'删除：A'})).toBeDisabled(); expect(screen.getByRole('button',{name:'引导：A'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'刷新队列确认结果'})); expect(refresh).toHaveBeenCalledOnce();
  view.rerender(<ControlQueue {...props} operations={{a:{status:'failed',error:'冲突'}}} />);
  expect(screen.getByText('冲突')).toBeVisible(); expect(screen.getByRole('button',{name:'删除：A'})).toBeEnabled();
});
