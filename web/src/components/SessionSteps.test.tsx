import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SessionSteps } from './SessionSteps';
import type { SessionStep } from '../../../src/shared/session-steps';

function show(kind: SessionStep['kind'], content: unknown, images?: SessionStep['images']) {
  render(<SessionSteps sessionSelected snapshot={{ sessionId: 's', projectionId: 'p', revision: 1,
    steps: [{ id: 'one', kind, content, images, source: 'recorded', status: 'completed', omission: 'Image binary omitted' }] }} />);
  return screen.getByTestId('session-step');
}
describe('projector DTO readable content', () => {
  it('updates the shared number gutter across 999 → 1000 without changing row identity or expansion', () => {
    // Sparse layout fixture mounts only the boundary row, still using real index+1.
    const steps: SessionStep[] = [];
    steps[998] = { id: 'boundary', kind: 'user', content: '完整原文', source: 'recorded', status: 'completed' };
    const snapshot = { sessionId: 's', projectionId: 'p', revision: 1, steps };
    const { rerender, container } = render(<SessionSteps sessionSelected snapshot={snapshot} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.steps-list')!.getAttribute('style')).toContain('3ch');
    expect(container.querySelector('.step-number')).toHaveTextContent('999');
    const next = steps.slice();
    next.push({ ...steps[998], id: 'next' });
    rerender(<SessionSteps sessionSelected snapshot={{ ...snapshot, revision: 2, steps: next }} />);
    expect(container.querySelector('.steps-list')!.getAttribute('style')).toContain('4ch');
    expect([...container.querySelectorAll('.step-number')].map(el => el.textContent)).toEqual(['999', '1000']);
    expect(screen.getAllByTestId('session-step').map(el => el.dataset.stepId)).toEqual(['boundary', 'next']);
    expect(screen.getAllByRole('button')[0]).not.toHaveAttribute('aria-expanded');
    expect(screen.getByTestId('session-steps')).not.toHaveAttribute('title');
  });
  it('keeps consecutive metadata and system records compact without removing public fields', () => {
    const contents = [
      { type: 'model_change', provider: 'openai', modelId: 'gpt-5.5', unknown: { n: null, f: false, z: 0, s: '', array: [] } },
      { type: 'thinking_level_change', thinkingLevel: 'medium', extra: '原文末尾' },
      { content: '', sections: { system: '系统完整原文末尾', removed: null }, toolsAdded: [], toolsRemoved: null },
    ];
    render(<SessionSteps sessionSelected snapshot={{ sessionId: 's', projectionId: 'p', revision: 1, steps: contents.map((content, i) => ({
      id: String(i), kind: 'system_event', label: ['model_change', 'thinking_level_change', 'system'][i], content,
      status: 'completed', source: 'recorded', omission: 'Only public entry fields shown; extension state omitted',
    })) }} />);
    const rows = screen.getAllByTestId('session-step');
    expect(rows.map(row => row.dataset.stepId)).toEqual(['0', '1', '2']);
    expect(rows.map(row => row.querySelector('pre')!.textContent)).toEqual(['openai / gpt-5.5', 'medium', 'system：系统完整原文末尾']);
    expect(document.querySelectorAll('.step-note')).toHaveLength(0);
    expect(screen.queryByLabelText('内容限制说明')).toBeNull();
    rows.forEach((row, i) => {
      fireEvent.click(row.querySelector('button')!);
      expect(screen.getByRole('dialog').querySelector('pre')!.textContent).toBe(JSON.stringify(contents[i], null, 2));
      expect(screen.getByRole('dialog')).not.toHaveTextContent('仅展示公开记录字段；扩展内部状态未公开。');
      fireEvent.click(screen.getByRole('button', {name: '关闭对话框'}));
    });
  });
  it('preserves multiple user blocks, unknown fields and inert image omissions', () => {
    const row = show('user', [
      { type: 'image', data: '[omitted]', url: 'https://invalid.example/image.png' },
      { type: 'text', text: '用户原文\n第二行', extra: false },
      { type: 'text', text: '第二文本块' },
      { type: 'unknown', payload: '<img src=x onerror=alert(1)>', value: null },
    ]);
    expect(row.querySelector('pre')!.textContent).toBe('用户原文\n第二行');
    fireEvent.click(screen.getByRole('button'));
    const text = screen.getByRole('dialog').querySelector('pre')!.textContent!;
    for (const part of ['用户原文\n第二行', '第二文本块', '"extra": false', '"type": "image"', '[omitted]', 'https://invalid.example/image.png', '<img src=x onerror=alert(1)>', '"value": null']) expect(text).toContain(part);
    expect(row.querySelectorAll('img, a, iframe')).toHaveLength(0);
    expect(row).not.toHaveTextContent('Image binary omitted');
  });
  it('keeps result metadata, falsy values, nested calls and the unknown long tail', () => {
    const tail = '长字段'.repeat(1000) + 'UNKNOWN_END';
    const row = show('tool_result', { content: [{ type: 'text', text: '结果原文\n换行' }, { type: 'text', text: '第二结果' }],
      details: { count: 0, ok: false, empty: null }, nestedCalls: [{ content: null, arguments: { enabled: false } }], unknown: tail });
    expect(row.querySelector('pre')!.textContent).toBe('结果原文\n换行');
    fireEvent.click(screen.getByRole('button'));
    const text = screen.getByRole('dialog').querySelector('pre')!.textContent!;
    for (const part of ['结果原文\n换行', '第二结果', '"count": 0', '"ok": false', '"empty": null', '"nestedCalls"', '"enabled": false', tail]) expect(text).toContain(part);
  });
  for (const content of [null, false, 0, { type: 'future', content: '<script>unsafe</script>' }]) {
    it(`safely falls back for ${JSON.stringify(content)}`, () => {
      const row = show('tool_result', content);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByRole('dialog').querySelector('pre')!.textContent).toBe(JSON.stringify(content, null, 2));
      expect(row.querySelector('script')).toBeNull();
    });
  }
  it('retains validated image attachments only on expansion', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
    const row = show('user', [{ type: 'text', text: '图片说明' }, { type: 'image', data: '[omitted]' }], [
      { mediaType: 'image/png', base64 }, { mediaType: 'image/svg+xml', base64: 'PHN2Zz4=' },
    ] as SessionStep['images']);
    expect(row.querySelectorAll('img')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button'));
    expect(row.querySelectorAll('img')).toHaveLength(1);
    expect(row.querySelector('img')).toHaveAttribute('src', `data:image/png;base64,${base64}`);
    expect(row).toHaveTextContent('[omitted]');
  });
  it('does not extract text-like tool arguments', () => {
    const args = { content: [{ type: 'text', text: 'argument' }], flag: false, count: 0 };
    show('tool_call', args);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').querySelector('pre')!.textContent).toBe(JSON.stringify(args, null, 2));
  });
});

it('navigates by source identity and restarts the five-second highlight on repeated clicks', () => {
  vi.useFakeTimers();
  const target = document.createElement('div');
  target.dataset.timelineId = 'history-assistant-text:entry:0';
  target.scrollIntoView = vi.fn();
  document.body.append(target);
  const snapshot = { sessionId: 's', projectionId: 'p', revision: 1, steps: [{id:'entry:entry:0', sourceEntryId:'entry', kind:'assistant_text' as const, content:'answer', source:'recorded' as const, status:'completed' as const}] };
  const { unmount } = render(<SessionSteps sessionSelected snapshot={snapshot} />);
  fireEvent.click(screen.getByRole('button'));
  expect(target.scrollIntoView).toHaveBeenCalledWith({behavior:'smooth', block:'center'});
  expect(target).toHaveClass('timeline-entry-highlight');
  expect(screen.queryByRole('dialog')).toBeNull();
  vi.advanceTimersByTime(4000);
  fireEvent.click(screen.getByRole('button'));
  vi.advanceTimersByTime(4999);
  expect(target).toHaveClass('timeline-entry-highlight');
  vi.advanceTimersByTime(1);
  expect(target).not.toHaveClass('timeline-entry-highlight');
  fireEvent.click(screen.getByRole('button'));
  unmount();
  expect(target).not.toHaveClass('timeline-entry-highlight');
  target.remove();
  vi.useRealTimers();
});

it('searches full content and tool names while preserving original numbers', () => {
  const steps: SessionStep[] = [
    {id:'a',kind:'user',content:'hello',source:'recorded',status:'completed'},
    {id:'b',kind:'tool_call',toolName:'BASH',content:{command:'pwd',details:'hidden-tail'},source:'recorded',status:'completed'},
    {id:'c',kind:'assistant_text',content:'finished',source:'recorded',status:'completed'},
  ];
  render(<SessionSteps sessionSelected snapshot={{sessionId:'s',projectionId:'p',revision:1,steps}} />);
  const input = screen.getByRole('searchbox', {name:'搜索轨迹'});
  fireEvent.change(input, {target:{value:'bash hidden-tail'}});
  expect(screen.getAllByTestId('session-step')).toHaveLength(1);
  expect(screen.getByTestId('session-step').querySelector('.step-number')).toHaveTextContent('2');
  expect(screen.getByText('1 / 3 条')).toBeVisible();
  fireEvent.change(input, {target:{value:'不存在'}});
  expect(screen.getByText('没有匹配的轨迹')).toBeVisible();
  fireEvent.keyDown(input, {key:'Escape'});
  expect(input).toHaveValue('');
  expect(screen.getAllByTestId('session-step')).toHaveLength(3);
});

it('preserves search and skips trace navigation until a new click after search is cleared', () => {
  vi.useFakeTimers();
  const target = document.createElement('div');
  target.dataset.timelineId = 'history-message:two';
  document.body.append(target);
  const steps: SessionStep[] = [
    {id:'first',sourceEntryId:'one',kind:'user',content:'first',source:'recorded',status:'completed'},
    {id:'second',sourceEntryId:'two',kind:'user',content:'second',source:'recorded',status:'completed'},
  ];
  const snapshot = {sessionId:'s',projectionId:'p',revision:1,steps};
  const {rerender,unmount} = render(<SessionSteps sessionSelected snapshot={snapshot} />);
  const row = screen.getAllByTestId('session-step')[1];
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  fireEvent.change(screen.getByRole('searchbox'), {target:{value:'first'}});
  const navigation = {sessionId:'s',timelineId:'history-message:two',sequence:1};
  rerender(<SessionSteps sessionSelected snapshot={snapshot} navigation={navigation} />);
  expect(screen.getByRole('searchbox')).toHaveValue('first');
  expect(scroll).not.toHaveBeenCalled();
  expect(screen.getAllByTestId('session-step')).toHaveLength(1);
  // Even a visible search result must not trigger linked navigation.
  fireEvent.change(screen.getByRole('searchbox'), {target:{value:'second'}});
  rerender(<SessionSteps sessionSelected snapshot={snapshot} navigation={{...navigation, sequence:2}} />);
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('searchbox'), {target:{value:''}});
  expect(scroll).not.toHaveBeenCalled();
  const nextNavigation = {...navigation, sequence:3};
  rerender(<SessionSteps sessionSelected snapshot={snapshot} navigation={nextNavigation} />);
  const revealed = screen.getAllByTestId('session-step')[1];
  expect(revealed).toHaveClass('trace-step-highlight');
  expect(scroll).toHaveBeenCalledOnce();
  rerender(<SessionSteps sessionSelected snapshot={{...snapshot,revision:2}} navigation={nextNavigation} />);
  expect(scroll).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(5000);
  expect(revealed).not.toHaveClass('trace-step-highlight');
  rerender(<SessionSteps sessionSelected snapshot={snapshot} navigation={{...navigation,sequence:4}} />);
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(revealed).toHaveClass('trace-step-highlight');
  unmount();
  expect(revealed).not.toHaveClass('trace-step-highlight');
  expect(row.isConnected).toBe(false);
  target.remove();
  HTMLElement.prototype.scrollIntoView = original;
  vi.useRealTimers();
});
