import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { BUBBLE_MS, CompanionDock, CompanionWelcome, GREETING_WAIT_MS, PENDING_SHOW_MS, PREFETCH_DELAY_MS, useCompanionPersona, usePrefetchGreeting,
  type CompanionPersonaSync, type CompanionWelcomeProps } from './Companion.js';
import { CompanionFigure } from './CompanionFigure.js';
import { DEFAULT_PERSONA, readPersona, writePersona, type CompanionPersona } from './companion-lines.js';
import type { RunStatus } from '../../hooks/useRunStatus.js';

function Welcome() {
  const [persona, setPersona] = useState<CompanionPersona>(DEFAULT_PERSONA);
  return <CompanionWelcome mood="idle" nodKey={0} persona={persona} onPersona={setPersona} projectId="p" projectName="repo"
    recent={null} now={() => new Date(2026, 9, 16, 9)} seed={1} />;
}

describe('companion', () => {
  afterEach(() => localStorage.clear());

  it('renames itself and changes voice from its own figure', () => {
    render(<Welcome />);
    expect(screen.getByText('小派')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /和小派打招呼/ }));
    fireEvent.click(screen.getByRole('radio', { name: '正式' }));
    expect(screen.getByText(/^早上好。请问今天在 repo/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '阿派' } });
    fireEvent.click(screen.getByRole('button', { name: '好了' }));
    expect(screen.getByText('阿派')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-editor')).not.toBeInTheDocument();
  });

  it('speaks the model\'s line when it arrives in time, telling it the persona, time of day and recent session', async () => {
    const generateLines = vi.fn<NonNullable<CompanionWelcomeProps['generateLines']>>().mockResolvedValue({ greeting: '早呀，repo！', hint: '接着修登录吧' });
    render(<CompanionWelcome mood="idle" nodKey={0} persona={DEFAULT_PERSONA} onPersona={() => {}} projectId="p" projectName="repo"
      recent={{ title: '修登录', updatedAt: new Date(2026, 9, 16, 8, 30).getTime() }} now={() => new Date(2026, 9, 16, 9)} seed={1} generateLines={generateLines} />);
    expect(await screen.findByText('早呀，repo！')).toBeInTheDocument();
    expect(screen.getByText('接着修登录吧')).toBeInTheDocument();
    expect(generateLines).toHaveBeenCalledWith({ persona: { name: '小派', style: 'lively' }, dayPart: 'morning', recent: { title: '修登录', minutesAgo: 30 } });
  });

  it('falls back to its own line when the model fails or is slow, and does not swap in a late reply', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: { greeting: string; hint: string }) => void;
      render(<CompanionWelcome mood="idle" nodKey={0} persona={DEFAULT_PERSONA} onPersona={() => {}} projectId="p" projectName="repo"
        recent={null} now={() => new Date(2026, 9, 16, 9)} seed={1} generateLines={() => new Promise(done => { resolve = done; })} />);
      await act(async () => { vi.advanceTimersByTime(GREETING_WAIT_MS); });
      const local = screen.getByText(/repo/).textContent;
      await act(async () => { resolve({ greeting: '迟到的问候', hint: '迟到的建议' }); });
      expect(screen.queryByText('迟到的问候')).not.toBeInTheDocument();
      expect(screen.getByText(/repo/).textContent).toBe(local);
    } finally { vi.useRealTimers(); }
  });

  it('asks only once the session list is in, and still times out if it never arrives', async () => {
    vi.useFakeTimers();
    try {
      const generateLines = vi.fn(() => new Promise<never>(() => {}));
      render(<CompanionWelcome mood="idle" nodKey={0} persona={DEFAULT_PERSONA} onPersona={() => {}} projectId="p" projectName="repo"
        recent={undefined} now={() => new Date(2026, 9, 16, 9)} seed={1} generateLines={generateLines} />);
      await act(async () => { vi.advanceTimersByTime(PENDING_SHOW_MS); });
      expect(screen.getByLabelText('正在想开场白')).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(GREETING_WAIT_MS - PENDING_SHOW_MS); });
      expect(generateLines).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('正在想开场白')).not.toBeInTheDocument();
      expect(screen.getByText(/repo/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('shows it is thinking only after a moment, so a cached line never flashes the dots first', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: { greeting: string; hint: string }) => void;
      const { container } = render(<CompanionWelcome mood="idle" nodKey={0} persona={DEFAULT_PERSONA} onPersona={() => {}} projectId="p" projectName="repo"
        recent={null} now={() => new Date(2026, 9, 16, 9)} seed={1} generateLines={() => new Promise(done => { resolve = done; })} />);
      const figure = () => container.querySelector('.companion-figure')!;
      await act(async () => { vi.advanceTimersByTime(PENDING_SHOW_MS - 1); });
      expect(screen.queryByLabelText('正在想开场白')).not.toBeInTheDocument();
      expect(figure()).toHaveAttribute('data-mood', 'idle');
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(screen.getByLabelText('正在想开场白')).toBeInTheDocument();
      expect(figure()).toHaveAttribute('data-mood', 'thinking');
      await act(async () => { resolve({ greeting: '来啦', hint: '说吧' }); });
      expect(screen.getByText('来啦')).toBeInTheDocument();
      expect(figure()).toHaveAttribute('data-mood', 'idle');
    } finally { vi.useRealTimers(); }
  });

  it('offers the project\'s templates and skills as names alone, with the description on hover', async () => {
    const onQuickStart = vi.fn();
    render(<CompanionWelcome mood="idle" nodKey={0} persona={DEFAULT_PERSONA} onPersona={() => {}} projectId="p" projectName="repo" recent={null}
      loadCommands={async () => [{ name: 'review', source: 'prompt', description: 'Review a change' }, { name: 'skill:dws', source: 'skill', description: '' }]}
      onQuickStart={onQuickStart} now={() => new Date(2026, 9, 16, 9)} seed={1} />);
    const review = await screen.findByRole('button', { name: '/review' });
    expect(review).toHaveAttribute('title', 'Review a change');
    expect(screen.getByRole('button', { name: '/skill:dws' })).not.toHaveAttribute('title');
    fireEvent.click(review);
    expect(onQuickStart).toHaveBeenCalledWith('/review ');
  });

  it('draws a simpler face at docked size: bigger eyes, no blush, catchlights or nose', () => {
    const { container, rerender } = render(<CompanionFigure mood="idle" size={128} alive={false} />);
    const eyeWidth = () => Number(container.querySelector('.companion-eye ellipse')!.getAttribute('rx'));
    const full = eyeWidth();
    expect(container.querySelector('.companion-blush')).toBeInTheDocument();
    expect(container.querySelector('.companion-shine')).toBeInTheDocument();
    expect(container.querySelector('.companion-nose')).toBeInTheDocument();
    rerender(<CompanionFigure mood="idle" size={44} alive={false} />);
    expect(container.querySelector('.companion-figure')).toHaveAttribute('data-size', 'small');
    expect(container.querySelector('.companion-blush')).not.toBeInTheDocument();
    expect(container.querySelector('.companion-shine')).not.toBeInTheDocument();
    expect(container.querySelector('.companion-nose')).not.toBeInTheDocument();
    expect(eyeWidth()).toBeGreaterThan(full);
  });

  it('docks with its mood on hover and can be sent away and called back', () => {
    const onPersona = vi.fn();
    const { rerender } = render(<CompanionDock mood="working" run="running" nodKey={0} persona={DEFAULT_PERSONA} onPersona={onPersona} />);
    const dock = screen.getByTestId('companion-dock');
    expect(dock).toHaveAttribute('title', '小派：埋头干活中！');
    fireEvent.click(dock);
    expect(onPersona).toHaveBeenCalledWith({ ...DEFAULT_PERSONA, docked: false });
    rerender(<CompanionDock mood="working" run="running" nodKey={0} persona={{ ...DEFAULT_PERSONA, docked: false }} onPersona={onPersona} />);
    expect(screen.getByRole('button', { name: '叫回小派' })).toBeInTheDocument();
    expect(readPersona()).toEqual(DEFAULT_PERSONA);
  });

  describe('a word when a run ends', () => {
    const Dock = ({ run, persona = DEFAULT_PERSONA }: { run: RunStatus['kind']; persona?: CompanionPersona }) =>
      <CompanionDock mood="idle" run={run} nodKey={0} persona={persona} onPersona={() => {}} />;
    const setVisibility = (state: DocumentVisibilityState) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    afterEach(() => { setVisibility('visible'); vi.useRealTimers(); });

    it('says the run is done, in its own voice, for a few seconds', () => {
      vi.useFakeTimers();
      const { rerender } = render(<Dock run="running" />);
      expect(screen.queryByTestId('companion-bubble')).not.toBeInTheDocument();
      rerender(<Dock run="completed" />);
      expect(screen.getByTestId('companion-bubble')).toHaveTextContent('搞定啦！快看看～');
      act(() => { vi.advanceTimersByTime(BUBBLE_MS); });
      expect(screen.queryByTestId('companion-bubble')).not.toBeInTheDocument();
    });

    it('says a run failed, but not that it was stopped', () => {
      const { rerender } = render(<Dock run="running" persona={{ ...DEFAULT_PERSONA, style: 'concise' }} />);
      rerender(<Dock run="failed" persona={{ ...DEFAULT_PERSONA, style: 'concise' }} />);
      expect(screen.getByTestId('companion-bubble')).toHaveAttribute('data-kind', 'failed');
      expect(screen.getByTestId('companion-bubble')).toHaveTextContent('失败了，看下错误。');
      rerender(<Dock run="running" />);
      expect(screen.queryByTestId('companion-bubble')).not.toBeInTheDocument();
      rerender(<Dock run="aborted" />);
      expect(screen.queryByTestId('companion-bubble')).not.toBeInTheDocument();
    });

    it('keeps quiet when the page is not in front, or when it has been sent away', () => {
      setVisibility('hidden');
      const { rerender } = render(<Dock run="running" />);
      rerender(<Dock run="completed" />);
      expect(screen.queryByTestId('companion-bubble')).not.toBeInTheDocument();
      setVisibility('visible');
      rerender(<Dock run="running" persona={{ ...DEFAULT_PERSONA, docked: false }} />);
      rerender(<Dock run="completed" persona={{ ...DEFAULT_PERSONA, docked: false }} />);
      expect(screen.queryByTestId('companion-bubble')).not.toBeInTheDocument();
    });
  });

  describe('asking for the next welcome ahead of time', () => {
    const at = () => new Date(2026, 9, 16, 9);
    const recent = { title: '修登录', updatedAt: new Date(2026, 9, 16, 8, 30).getTime() };
    afterEach(() => vi.useRealTimers());

    it('asks once things are quiet, with what the blank page would send, and not again for the same moment', () => {
      vi.useFakeTimers();
      const generate = vi.fn(async () => ({ greeting: '早', hint: '好' }));
      const { rerender } = renderHook(({ quiet, updatedAt }) => usePrefetchGreeting(generate, 'p', DEFAULT_PERSONA, { ...recent, updatedAt }, quiet, at),
        { initialProps: { quiet: false, updatedAt: recent.updatedAt } });
      act(() => { vi.advanceTimersByTime(PREFETCH_DELAY_MS * 2); });
      expect(generate).not.toHaveBeenCalled();
      rerender({ quiet: true, updatedAt: recent.updatedAt });
      act(() => { vi.advanceTimersByTime(PREFETCH_DELAY_MS); });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledWith({ persona: { name: '小派', style: 'lively' }, dayPart: 'morning', recent: { title: '修登录', minutesAgo: 30 } });
      // Still within the same hour as far as the cached line goes.
      rerender({ quiet: true, updatedAt: recent.updatedAt + 10 * 60_000 });
      act(() => { vi.advanceTimersByTime(PREFETCH_DELAY_MS); });
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a way to ask, a project or the session list', () => {
      vi.useFakeTimers();
      const generate = vi.fn(async () => ({ greeting: '早', hint: '好' }));
      renderHook(() => usePrefetchGreeting(generate, null, DEFAULT_PERSONA, recent, true, at));
      renderHook(() => usePrefetchGreeting(generate, 'p', DEFAULT_PERSONA, undefined, true, at));
      renderHook(() => usePrefetchGreeting(undefined, 'p', DEFAULT_PERSONA, recent, true, at));
      act(() => { vi.advanceTimersByTime(PREFETCH_DELAY_MS * 2); });
      expect(generate).not.toHaveBeenCalled();
    });
  });

  describe('persona on the server', () => {
    const remote: CompanionPersona = { name: '阿布', style: 'formal', docked: false };
    const sync = (load: CompanionPersonaSync['load'], save = vi.fn<CompanionPersonaSync['save']>().mockResolvedValue()) => ({ load, save });

    it('takes the server\'s persona and keeps a copy in this browser', async () => {
      const { result } = renderHook(() => useCompanionPersona(useState(() => sync(async () => remote))[0]));
      expect(result.current[0]).toEqual(DEFAULT_PERSONA);
      await waitFor(() => expect(result.current[0]).toEqual(remote));
      expect(readPersona()).toEqual(remote);
    });

    it('carries a persona set in this browser up once when the server has none', async () => {
      writePersona(remote);
      const s = sync(async () => null);
      const { result } = renderHook(() => useCompanionPersona(useState(() => s)[0]));
      expect(result.current[0]).toEqual(remote);
      await waitFor(() => expect(s.save).toHaveBeenCalledWith(remote));
    });

    it('leaves the defaults on this browser alone when neither side has a persona', async () => {
      const s = sync(async () => null);
      renderHook(() => useCompanionPersona(useState(() => s)[0]));
      await act(async () => {});
      expect(s.save).not.toHaveBeenCalled();
    });

    it('keeps a change made before the server answers, saves changes in order, and keeps them here when a save fails', async () => {
      let answer!: (persona: CompanionPersona | null) => void;
      const order: string[] = [];
      const s = sync(() => new Promise(resolve => { answer = resolve; }), vi.fn<CompanionPersonaSync['save']>(async persona => {
        order.push(persona.name);
        if (persona.name === '一') throw new Error('down');
      }));
      const { result } = renderHook(() => useCompanionPersona(useState(() => s)[0]));
      act(() => result.current[1]({ ...DEFAULT_PERSONA, name: '一' }));
      act(() => result.current[1]({ ...DEFAULT_PERSONA, name: '二' }));
      await act(async () => answer(remote));
      expect(result.current[0].name).toBe('二');
      await waitFor(() => expect(order).toEqual(['一', '二']));
      expect(readPersona().name).toBe('二');
    });
  });
});
