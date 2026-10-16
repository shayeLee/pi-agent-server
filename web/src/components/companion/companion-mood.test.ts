import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { moodOf, SLEEP_MS, TYPING_MS, useCompanion, type CompanionSignals } from './companion-mood.js';

const base: CompanionSignals = { run: 'idle', focused: false, menu: false, typedAt: null, lastActivityAt: 0 };

describe('companion mood', () => {
  it('ranks how a run ended over what the person does, and that over what PI does', () => {
    expect(moodOf({ ...base, run: 'completed', menu: true }, 0)).toBe('happy');
    expect(moodOf({ ...base, run: 'failed' }, 0)).toBe('sad');
    expect(moodOf({ ...base, run: 'aborted' }, 0)).toBe('sad');
    expect(moodOf({ ...base, run: 'running', menu: true }, 0)).toBe('curious');
    expect(moodOf({ ...base, run: 'running', typedAt: 0 }, 10)).toBe('listening');
    expect(moodOf({ ...base, run: 'running', typedAt: 0, focused: true }, TYPING_MS)).toBe('working');
    expect(moodOf({ ...base, run: 'queued' }, 0)).toBe('thinking');
    expect(moodOf({ ...base, focused: true }, SLEEP_MS)).toBe('listening');
    expect(moodOf(base, SLEEP_MS - 1)).toBe('idle');
    expect(moodOf(base, SLEEP_MS)).toBe('sleepy');
  });

  it('hears typing, lets it fade, and nods once per send', async () => {
    let now = 1000;
    const { result, rerender } = renderHook(({ run }) => useCompanion(run, () => now), { initialProps: { run: 'idle' as const } });
    act(() => result.current.signal('type'));
    expect(result.current.mood).toBe('listening');
    now += TYPING_MS;
    rerender({ run: 'idle' });
    expect(result.current.mood).toBe('idle');
    act(() => result.current.signal('menu-open'));
    expect(result.current.mood).toBe('curious');
    act(() => result.current.signal('send'));
    expect(result.current).toMatchObject({ mood: 'idle', nodKey: 1 });
  });
});
