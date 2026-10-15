/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Read source directly: Vitest intentionally stubs CSS (including ?raw) in this app.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('single-source Ledger typography (DESIGN.md §2.2–2.3)', () => {
  it('defines the seven-step Ledger scale and maps legacy names onto it', () => {
    const tokens = source('./styles/tokens.css');
    const absoluteSizes = [...tokens.matchAll(/--fs-([\w-]+):\s*(\d+)px;/g)].map(([, name, size]) => [name, Number(size)]);
    expect(absoluteSizes).toEqual([['tag', 11], ['meta', 12], ['step', 13], ['ui', 14], ['body', 16], ['h2', 18], ['title', 20]]);
    // Legacy names are aliases only, never independent sizes.
    expect(tokens).not.toMatch(/--font-[\w-]+:\s*\d+px/);
    for (const [legacy, ledger] of [['xs', 'tag'], ['sm', 'meta'], ['base-sm', 'step'], ['md', 'ui'], ['base', 'body'], ['lg', 'h2'], ['xl', 'title'], ['session-title', 'title']]) {
      expect(tokens).toContain(`--font-${legacy}: var(--fs-${ledger});`);
    }
    expect(tokens).toContain('--font-sans: "IBM Plex Sans", "PingFang SC",');
    expect(tokens).toContain('--font-mono: "IBM Plex Mono",');
    expect(tokens).toContain('monospace;');
    expect(source('./styles.css')).not.toMatch(/font(?:-size)?:\s*\d+(?:\.\d+)?px/);
    expect(source('./styles.css')).not.toMatch(/--font-[\w-]+:\s*\d/);
    // Fonts are self-hosted from bundled packages only; never fetched from a CDN.
    expect(tokens + source('./styles.css')).not.toMatch(/@font-face|fonts\.googleapis|fonts\.gstatic/);
    const fonts = source('./styles/fonts.css');
    expect(fonts).not.toMatch(/https?:/);
    for (const weight of [400, 500, 600]) {
      expect(fonts).toContain(`@fontsource/ibm-plex-sans/latin-${weight}.css`);
      expect(fonts).toContain(`@fontsource/ibm-plex-mono/latin-${weight}.css`);
    }
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
