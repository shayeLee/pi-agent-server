/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Read source directly: Vitest intentionally stubs CSS (including ?raw) in this app.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('single-source seven-level typography', () => {
  it('defines the seven-level scale plus the dedicated session-title exception', () => {
    const tokens = source('./styles/tokens.css');
    const absoluteSizes = [...tokens.matchAll(/--font-([\w-]+):\s*(\d+)px;/g)].map(([, name, size]) => [name, Number(size)]);
    expect(absoluteSizes.filter(([name]) => name !== 'session-title'))
      .toEqual([['xs', 10], ['sm', 11], ['base-sm', 12], ['md', 13], ['base', 14], ['lg', 16], ['xl', 20]]);
    expect(absoluteSizes.filter(([name]) => name === 'session-title')).toEqual([['session-title', 18]]);
    expect(tokens).toContain('--font-sans: -apple-system,');
    expect(tokens).toContain('"PingFang SC"');
    expect(tokens).toContain('--font-mono: SFMono-Regular,');
    expect(tokens).toContain('monospace;');
    expect(source('./styles.css')).not.toMatch(/font(?:-size)?:\s*\d+(?:\.\d+)?px/);
    expect(source('./styles.css')).not.toMatch(/--font-[\w-]+:\s*\d/);
    expect(tokens + source('./styles.css')).not.toMatch(/@font-face/);
  });
  it('maps prefixed utilities to the same scale without Tailwind preflight', () => {
    const ui = source('./styles/ui.css');
    expect(ui).not.toContain('preflight.css');
    expect(ui).toContain('prefix(ui)');
    for (const size of ['xs', 'sm', 'base-sm', 'md', 'base', 'lg', 'xl']) {
      expect(ui).toContain(`--text-${size}: var(--font-${size});`);
    }
    for (const primitive of ['button', 'dropdown-menu', 'popover']) {
      expect(source(`./components/ui/${primitive}.tsx`)).toContain('ui:text-base-sm');
    }
  });
});
