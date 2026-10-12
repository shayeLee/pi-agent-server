import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { SessionRecord } from 'pi-agent-server/client';
import { ChatHeader } from './ChatHeader';

const session = { id: 'header-test', title: '题头测试' } as SessionRecord;
describe('ChatHeader disclosure', () => {
  it('has one file-text toggle, no tab navigation or extra actions', () => {
    const onToggleTrace = vi.fn();
    const { rerender, container } = render(<ChatHeader session={session} traceOpen={false} onToggleTrace={onToggleTrace} />);
    const toggle = screen.getByRole('button', { name: '轨迹' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-tab')).not.toBeInTheDocument();
    expect(toggle).not.toHaveAttribute('aria-current');
    expect(toggle).toHaveAttribute('aria-controls', 'session-inspector');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('title', '打开轨迹');
    expect(container.querySelector('svg[data-icon="file"]')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(toggle);
    rerender(<ChatHeader session={session} traceOpen onToggleTrace={onToggleTrace} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('title', '关闭轨迹');
    fireEvent.click(toggle);
    expect(onToggleTrace).toHaveBeenCalledTimes(2);
  });
});
