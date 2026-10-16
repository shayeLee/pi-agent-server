import { describe, expect, it } from 'vitest';
import { applyCompletion, completionToken, fileReference, filterCommands, hostCommand } from './composer-completion.js';

describe('completionToken', () => {
  it('reads a command only as the first token', () => {
    expect(completionToken('/com', 4)).toEqual({ kind: 'command', query: 'com', start: 0, end: 4 });
    expect(completionToken('/', 1)).toMatchObject({ kind: 'command', query: '' });
    expect(completionToken('/compact now', 12)).toBeNull();
    expect(completionToken('say /com', 8)).toBeNull();
  });
  it('reads @ paths after whitespace, including a quoted path with spaces', () => {
    expect(completionToken('look at @src/cl', 15)).toEqual({ kind: 'file', query: 'src/cl', start: 8, end: 15 });
    expect(completionToken('@', 1)).toMatchObject({ kind: 'file', query: '', start: 0 });
    expect(completionToken('see @"my dir/fi', 15)).toMatchObject({ kind: 'file', query: 'my dir/fi', start: 4 });
    expect(completionToken('mail me@host', 12)).toBeNull();
    expect(completionToken('@src done', 9)).toBeNull();
  });
});

describe('completion edits', () => {
  it('quotes paths with whitespace and keeps directories open', () => {
    expect(fileReference({ path: 'src/cli.js', kind: 'file' })).toBe('@src/cli.js');
    expect(fileReference({ path: 'src', kind: 'directory' })).toBe('@src/');
    expect(fileReference({ path: 'my docs/a.md', kind: 'file' })).toBe('@"my docs/a.md"');
  });
  it('replaces only the token and places the caret after the insertion', () => {
    const token = completionToken('read @cl please', 8)!;
    expect(applyCompletion('read @cl please', token, '@src/cli.js', true)).toEqual({ text: 'read @src/cli.js please', caret: 16 });
    const end = completionToken('read @cl', 8)!;
    expect(applyCompletion('read @cl', end, '@src/cli.js', true)).toEqual({ text: 'read @src/cli.js ', caret: 17 });
    expect(applyCompletion('read @sr', completionToken('read @sr', 8)!, '@src/', false)).toEqual({ text: 'read @src/', caret: 10 });
  });
  it('ranks prefix matches before inner matches', () => {
    const commands = [{ name: 'compact', source: 'builtin', description: '' }, { name: 'reload', source: 'builtin', description: '' },
      { name: 'skill:review-code', source: 'skill', description: '' }, { name: 'review', source: 'prompt', description: '' }] as const;
    expect(filterCommands(commands, 're').map(c => c.name)).toEqual(['reload', 'review', 'skill:review-code']);
    expect(filterCommands(commands, '').length).toBe(4);
  });
});

describe('hostCommand', () => {
  it('recognises /compact with instructions and /reload, nothing else', () => {
    expect(hostCommand('/compact')).toEqual({ command: 'compact' });
    expect(hostCommand('  /compact keep the API decisions\nand file names ')).toEqual({ command: 'compact', args: 'keep the API decisions\nand file names' });
    expect(hostCommand('/reload')).toEqual({ command: 'reload' });
    expect(hostCommand('/reloaded')).toBeNull();
    expect(hostCommand('/review src')).toBeNull();
    expect(hostCommand('please /compact')).toBeNull();
  });
});
