import { afterEach, describe, expect, it } from 'vitest';
import { dayPart, DEFAULT_PERSONA, moodLine, openingLines, readPersona, writePersona } from './companion-lines.js';

const at = (hour: number) => new Date(2026, 9, 16, hour, 0, 0);
const first = () => 0;

describe('companion lines', () => {
  afterEach(() => localStorage.clear());

  it('splits the day where people feel it', () => {
    expect([2, 6, 9, 12, 15, 20, 23].map(dayPart)).toEqual(['night', 'dawn', 'morning', 'noon', 'afternoon', 'evening', 'night']);
  });

  it('greets by the time of day and the project, in the chosen voice', () => {
    const context = { persona: DEFAULT_PERSONA, now: at(9), projectName: 'pi-agent-server', recent: null, commandCount: null };
    expect(openingLines(context, first).greeting).toContain('pi-agent-server');
    expect(openingLines({ ...context, persona: { ...DEFAULT_PERSONA, style: 'formal' } }, first).greeting).toMatch(/^早上好。/);
    expect(openingLines({ ...context, projectName: null }, first).greeting).toContain('这个项目');
  });

  it('offers to pick up the last session, the project commands, or a file reference', () => {
    const context = { persona: { ...DEFAULT_PERSONA, style: 'concise' as const }, now: at(15), projectName: 'p',
      recent: { title: '修复登录', updatedAt: at(12).getTime() }, commandCount: 4 };
    const hints = [0, 0.5, 0.99].map(value => openingLines(context, () => value).hint);
    expect(hints).toEqual(['上次：「修复登录」，3 小时前。', '本项目有 4 个模板 / skill，输入 / 查看。', '输入 @ 引用项目文件。']);
  });

  it('keeps the persona per browser and survives bad or missing storage', () => {
    expect(readPersona()).toEqual(DEFAULT_PERSONA);
    writePersona({ name: '阿派', style: 'concise', docked: false });
    expect(readPersona()).toEqual({ name: '阿派', style: 'concise', docked: false });
    localStorage.setItem('pi.companion', '{"name":"  ","style":"loud"}');
    expect(readPersona()).toEqual(DEFAULT_PERSONA);
    localStorage.setItem('pi.companion', 'not json');
    expect(readPersona()).toEqual(DEFAULT_PERSONA);
    expect(moodLine({ ...DEFAULT_PERSONA, name: '阿派' }, 'working')).toBe('阿派：埋头干活中！');
  });
});
