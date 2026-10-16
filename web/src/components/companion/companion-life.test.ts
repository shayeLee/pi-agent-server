import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTICS, gazeOffset, useAntics } from './companion-life.js';

const rect = { left: 0, top: 0, width: 100, height: 100 };

describe('companion life', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('looks toward the pointer and settles a couple of figure-widths away', () => {
    expect(gazeOffset(rect, { x: 50, y: 40 })).toEqual([0, 0]);
    const [nearX] = gazeOffset(rect, { x: 100, y: 40 });
    const [farX, farY] = gazeOffset(rect, { x: 1000, y: 40 });
    expect(nearX).toBeGreaterThan(0);
    expect(farX).toBeGreaterThan(nearX);
    expect(gazeOffset(rect, { x: 5000, y: 40 })).toEqual([farX, farY]);
    expect(gazeOffset(rect, { x: 50, y: -1000 })[1]).toBeLessThan(0);
  });

  it('plays a different antic each time, and stops when disabled', () => {
    const random = () => 0;
    const { result, rerender } = renderHook(({ enabled }) => useAntics(enabled, random), { initialProps: { enabled: true } });
    expect(result.current).toBeNull();
    act(() => { vi.advanceTimersByTime(3500); });
    expect(result.current).toBe(ANTICS[0]);
    act(() => { vi.advanceTimersByTime(1600); });
    expect(result.current).toBeNull();
    act(() => { vi.advanceTimersByTime(3500); });
    expect(result.current).toBe(ANTICS[1]);
    rerender({ enabled: false });
    expect(result.current).toBeNull();
  });
});
