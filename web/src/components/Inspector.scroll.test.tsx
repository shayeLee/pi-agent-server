import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { SessionRecord } from 'pi-agent-server/client';
import type { SessionStepsSnapshot } from '../../../src/shared/session-steps.js';
import { Inspector, type InspectorTab } from './Inspector.js';

afterEach(() => vi.unstubAllGlobals());
const session = { id: 's' } as SessionRecord;
const snapshot = (revision: number): SessionStepsSnapshot => ({
  sessionId: 's', projectionId: 'p', revision,
  steps: [{ id: 'a', kind: 'assistant_text', status: 'streaming', source: 'observed', content: `output ${revision}` }],
});

describe('Inspector follows output', () => {
  it.each(['steps', 'events'] as InspectorTab[])('%s follows growth and resumes only after returning to the bottom', tab => {
    const view = (revision: number) => <Inspector session={session} activeTab={tab} steps={snapshot(revision)}
      entries={[{seq: revision, type: 'text_delta', time: '10:00', data: 'text'}]} onClearEvents={vi.fn()} />;
    const { rerender } = render(view(1));
    const el = (tab === 'steps' ? screen.getByRole('tabpanel') : document.querySelector('.event-log-list')) as HTMLElement;
    let height = 1000;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 300 },
    });
    rerender(view(2));
    expect(el.scrollTop).toBe(1000);
    el.scrollTop = 700; fireEvent.scroll(el);
    height = 1200; rerender(view(3));
    expect(el.scrollTop).toBe(1200);
    el.scrollTop = 900; fireEvent.scroll(el);
    el.scrollTop = 200; fireEvent.scroll(el);
    height = 1400; rerender(view(4));
    expect(el.scrollTop).toBe(200);
    el.scrollTop = 1100; fireEvent.scroll(el);
    height = 1600; rerender(view(5));
    expect(el.scrollTop).toBe(1600);
  });

  it('keeps event disclosure reading in place, including asynchronous resizing', () => {
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe() {}
      disconnect = disconnect;
    });
    const { rerender, unmount } = render(<Inspector session={session} activeTab="events"
      entries={[{seq: 1, type: 'error', time: '10:00', data: 'details'}]} onClearEvents={vi.fn()} />);
    const el = document.querySelector('.event-log-list') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', {configurable: true, value: 1000});
    callbacks.forEach(callback => callback([], {} as ResizeObserver));
    expect(el.scrollTop).toBe(1000);
    fireEvent.click(screen.getByTestId('event-1').querySelector('summary')!);
    el.scrollTop = 400;
    callbacks.forEach(callback => callback([], {} as ResizeObserver));
    expect(el.scrollTop).toBe(400);
    rerender(<Inspector session={session} activeTab="steps" steps={snapshot(2)} entries={[]} onClearEvents={vi.fn()} />);
    expect(disconnect).toHaveBeenCalled();
    unmount();
  });
});
