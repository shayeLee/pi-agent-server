import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { CompanionDock, CompanionWelcome, GREETING_WAIT_MS, useCompanionPersona, type CompanionPersonaSync, type CompanionWelcomeProps } from './Companion.js';
import { DEFAULT_PERSONA, readPersona, writePersona, type CompanionPersona } from './companion-lines.js';

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
    expect(screen.getByLabelText('正在想开场白')).toBeInTheDocument();
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
      expect(screen.getByLabelText('正在想开场白')).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(GREETING_WAIT_MS); });
      expect(generateLines).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('正在想开场白')).not.toBeInTheDocument();
      expect(screen.getByText(/repo/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('docks with its mood on hover and can be sent away and called back', () => {
    const onPersona = vi.fn();
    const { rerender } = render(<CompanionDock mood="working" nodKey={0} persona={DEFAULT_PERSONA} onPersona={onPersona} />);
    const dock = screen.getByTestId('companion-dock');
    expect(dock).toHaveAttribute('title', '小派：埋头干活中！');
    fireEvent.click(dock);
    expect(onPersona).toHaveBeenCalledWith({ ...DEFAULT_PERSONA, docked: false });
    rerender(<CompanionDock mood="working" nodKey={0} persona={{ ...DEFAULT_PERSONA, docked: false }} onPersona={onPersona} />);
    expect(screen.getByRole('button', { name: '叫回小派' })).toBeInTheDocument();
    expect(readPersona()).toEqual(DEFAULT_PERSONA);
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
