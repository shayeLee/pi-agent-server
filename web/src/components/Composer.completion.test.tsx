import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionCommandInfo, SessionRecord } from 'pi-agent-server/client';
import { Composer, type ComposerProps } from './Composer.js';

const commands: SessionCommandInfo[] = [
  { name: 'compact', source: 'builtin', description: '手动压缩会话上下文', argumentHint: '[总结要求]' },
  { name: 'reload', source: 'builtin', description: '重新加载' },
  { name: 'review', source: 'prompt', description: 'Review a change' },
];

function Harness(overrides: Partial<ComposerProps>) {
  const [text, setText] = useState('');
  return <Composer session={{ id: 's' } as SessionRecord} projects={[]} activeProjectId={null} onSelectProject={vi.fn()} canCreateSession={false}
    models={[]} thinkingLevels={[]} defaultModel={null} defaultThinkingLevel="off" streaming={false} queued={false} placeholder="task"
    onSend={vi.fn()} onFollowUp={vi.fn()} onConfigChange={vi.fn()} draft={{ text, attachments: [], settings: {} }} onDraftText={setText}
    loadCommands={async () => commands} searchFiles={async () => [{ path: 'src', kind: 'directory' }, { path: 'src/cli.js', kind: 'file' }]}
    {...overrides} />;
}

const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;
function type(value: string) {
  fireEvent.change(input(), { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

describe('composer completion menus', () => {
  it('suggests project paths after @ and inserts the reference', async () => {
    const searchFiles = vi.fn(async () => [{ path: 'src/cli.js', kind: 'file' as const }]);
    render(<Harness searchFiles={searchFiles} />);
    type('explain @cl');
    expect(await screen.findByRole('option', { name: /cli\.js/ })).toHaveAttribute('aria-selected', 'true');
    expect(searchFiles).toHaveBeenLastCalledWith('cl');
    expect(input()).toHaveAttribute('aria-activedescendant', 'composer-menu-option-0');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input()).toHaveValue('explain @src/cli.js ');
    expect(screen.queryByTestId('composer-menu')).not.toBeInTheDocument();
  });

  it('moves with the arrow keys and keeps a picked directory open for its children', async () => {
    render(<Harness />);
    type('@');
    await screen.findByRole('option', { name: /cli\.js/ });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /cli\.js/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(input()).toHaveValue('@src/');
    expect(screen.getByTestId('composer-menu')).toBeInTheDocument();
  });

  it('closes on Esc without arming abort, and Enter then sends', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type('@sr');
    await screen.findByRole('option', { name: /cli\.js/ });
    const escape = fireEvent.keyDown(input(), { key: 'Escape' });
    expect(escape).toBe(false);
    expect(screen.queryByTestId('composer-menu')).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@sr'));
  });

  it('lists commands after a leading slash and completes the name', async () => {
    render(<Harness />);
    type('/re');
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual([expect.stringContaining('/reload'), expect.stringContaining('/review')]);
    expect(options[1]).toHaveTextContent('模板');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input()).toHaveValue('/reload ');
  });

  it('runs host commands instead of sending them and shows the result', async () => {
    const onSend = vi.fn();
    const onRunCommand = vi.fn(async () => '已重新加载');
    render(<Harness onSend={onSend} onRunCommand={onRunCommand} />);
    type('/compact keep decisions');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(onRunCommand).toHaveBeenCalledWith({ command: 'compact', args: 'keep decisions' }));
    expect(input()).toHaveValue('');
    type('/reload');
    fireEvent.blur(input());
    fireEvent.click(screen.getByTestId('send-button'));
    expect(await screen.findByTestId('composer-command-notice')).toHaveTextContent('已重新加载');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('clears the editor as soon as a command starts, and gives it back if it fails', async () => {
    let finish!: (notice: string | null) => void;
    let fail!: (error: Error) => void;
    const onRunCommand = vi.fn(() => new Promise<string | null>((resolve, reject) => { finish = resolve; fail = reject; }));
    render(<Harness onRunCommand={onRunCommand} />);
    type('/compact');
    fireEvent.blur(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(onRunCommand).toHaveBeenCalled());
    expect(input()).toHaveValue('');
    await act(async () => { finish(null); });
    expect(input()).toHaveValue('');

    type('/compact keep it');
    fireEvent.blur(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(input()).toHaveValue(''));
    fail(new Error('/compact 未完成：Nothing to compact'));
    expect(await screen.findByTestId('composer-submit-notice')).toHaveTextContent('Nothing to compact');
    expect(input()).toHaveValue('/compact keep it');
  });

  it('keeps a command typed during a run and explains why', async () => {
    const onRunCommand = vi.fn(async () => null);
    const onFollowUp = vi.fn();
    render(<Harness streaming onRunCommand={onRunCommand} onFollowUp={onFollowUp} onAbort={vi.fn()} />);
    type('/compact');
    fireEvent.blur(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByTestId('composer-submit-notice')).toHaveTextContent('运行中不能执行命令');
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(input()).toHaveValue('/compact');
  });

  it('reads the draft project before the session exists, and keeps host commands for sessions', async () => {
    const searchFiles = vi.fn(async () => [{ path: 'src/cli.js', kind: 'file' as const }]);
    const onRunCommand = vi.fn(async () => null);
    render(<Harness session={null} activeProjectId="p1" canCreateSession searchFiles={searchFiles} onRunCommand={onRunCommand} />);
    type('@cl');
    expect(await screen.findByRole('option', { name: /cli\.js/ })).toBeInTheDocument();
    type('/compact');
    fireEvent.blur(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(await screen.findByTestId('composer-submit-notice')).toHaveTextContent('请先发送第一条消息');
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(input()).toHaveValue('/compact');
  });

  it('offers no menus when the draft cannot create a session', () => {
    render(<Harness session={null} activeProjectId="p1" canCreateSession={false} />);
    type('@sr');
    expect(screen.queryByTestId('composer-menu')).not.toBeInTheDocument();
  });
});
