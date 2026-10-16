import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SubagentRun } from 'pi-agent-server/client';
import { SubagentLivePanel } from './SubagentLivePanel.js';

const run = { id: 'r1', runId: '1', agent: 'worker', task: 'fix it', startedAt: Date.now(), status: 'running', revision: 1 } as SubagentRun;

describe('SubagentLivePanel', () => {
  it('shows the latest assistant line after the tool steps, with a caret while it streams', () => {
    const view = render(<SubagentLivePanel items={[{ run, actions: [{ id: 't', toolName: 'read', summary: 'a.ts', done: true }], reply: { text: 'Reading the config', streaming: true } }]} />);
    const reply = screen.getByTestId('subagent-live-reply');
    expect(reply).toHaveTextContent('Reading the config');
    expect(reply).toHaveAttribute('title', 'Reading the config');
    expect(reply.querySelector('.ledger-caret')).not.toBeNull();
    expect(screen.getByText('read').compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.rerender(<SubagentLivePanel items={[{ run, actions: [], reply: { text: 'Done.', streaming: false } }]} />);
    expect(screen.getByTestId('subagent-live-reply').querySelector('.ledger-caret')).toBeNull();
  });
  it('omits the line when the child has no assistant text yet', () => {
    render(<SubagentLivePanel items={[{ run, actions: [] }]} />);
    expect(screen.queryByTestId('subagent-live-reply')).not.toBeInTheDocument();
  });
});
