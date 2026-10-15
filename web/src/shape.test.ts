/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Read source directly: Vitest intentionally stubs CSS (including ?raw) in this app.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
// jsdom replaces URL, which node:fs only accepts as a path string for directories.
const dir = (path: string) => readdirSync(new URL(path, import.meta.url).pathname);
const RADII = ['item', 'control', 'code', 'float', 'pill'];

describe('single-source Ledger corner radii (DESIGN.md §2.4)', () => {
  it('defines every radius once, in tokens.css', () => {
    const tokens = source('./styles/tokens.css');
    expect([...tokens.matchAll(/--radius-([\w-]+):\s*\d+px;/g)].map(([, name]) => name)).toEqual(RADII);
    expect(source('./styles.css')).not.toMatch(/--radius-[\w-]+:/);
    expect(source('./styles/ui.css')).not.toMatch(/--radius-[\w-]+:\s*\d/);
  });

  it('styles use only square corners or a radius token', () => {
    const values = [...source('./styles.css').matchAll(/border-radius:\s*([^;]+);/g)].map(([, value]) => value.trim());
    const allowed = new Set(['0', ...RADII.map(name => `var(--radius-${name})`)]);
    expect(values.filter(value => !allowed.has(value))).toEqual([]);
  });

  it('maps prefixed utilities onto the tokens, and only primitives use them', () => {
    const ui = source('./styles/ui.css');
    for (const [size, token] of [['sm', 'item'], ['md', 'control'], ['lg', 'float']]) {
      expect(ui).toContain(`--radius-${size}: var(--radius-${token});`);
    }
    const primitives = dir('./components/ui/').filter(file => file.endsWith('.tsx'));
    for (const file of primitives) {
      for (const utility of source(`./components/ui/${file}`).match(/ui:rounded-[\w[\]-]+/g) ?? []) {
        expect(['ui:rounded-sm', 'ui:rounded-md', 'ui:rounded-lg']).toContain(utility);
      }
    }
    const components = dir('./components/').filter(file => /\.tsx$/.test(file) && !file.includes('.test.'));
    for (const file of components) expect(source(`./components/${file}`)).not.toMatch(/borderRadius|ui:rounded/);
  });
});
