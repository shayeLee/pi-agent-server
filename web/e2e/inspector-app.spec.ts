import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { SessionStep, SessionStepsSnapshot } from '../../src/shared/session-steps';
import type { SessionSystemPrompt } from '../../src/shared/system-prompt';
import { workspaceFixture } from './workspace.fixture';

const evidence = '/tmp/pi-inspector-sidebar';
const longContent = Array.from({ length: 60 }, (_, i) => `完整结果 ${i + 1}：保留原始内容，不截断。`).join('\n') + '\nEND_OF_INSPECTOR_RESULT';
function snapshot(sessionId = 'fixture-0', revision = 1): SessionStepsSnapshot {
  const step = (id: string, kind: SessionStep['kind'], content: unknown, second: number, toolName?: string): SessionStep => ({
    id, kind, content, status: 'completed', source: 'recorded',
    timestamp: `2026-01-01T12:00:${String(second).padStart(2, '0')}Z`, toolName,
    ...(toolName ? { toolCallId: toolName } : {}),
  });
  return { sessionId, projectionId: `projection-${sessionId}`, revision, steps: [
    step('thinking', 'thinking', '先核对 B，再核对 A；顺序来自数组而不是时间。', 50),
    step('call-B', 'tool_call', { command: 'inspect B' }, 40, 'B'),
    { ...step('call-A', 'user', [
      { type: 'text', text: '用户原文：核对两个结果。\n保留用户换行。' },
      { type: 'text', text: '第二用户文本块' },
      { type: 'image', data: '[omitted]', mimeType: 'image/png' },
    ], 10), omission: 'Image binary omitted from content; only validated images are attached' },
    step('result-B', 'tool_result', { content: [{ type: 'text', text: longContent }, { type: 'text', text: '第二结果文本块' }],
      details: { count: 0, ok: false, empty: null }, nestedCalls: [{ name: 'read', result: { content: [{ type: 'text', text: '嵌套结果' }] } }],
      unknown: '未知字段完整保留。'.repeat(100) + 'UNKNOWN_FIELD_END' }, 30, 'B'),
    step('result-A', 'tool_result', { content: [{ type: 'text', text: 'A 完成' }], details: null }, 20, 'A'),
    { ...step('active', 'assistant_text', 'ACTIVE_INITIAL', 0), source: 'observed', status: 'streaming' },
  ] };
}
async function fixture(page: Page) {
  const unexpected = await workspaceFixture(page);
  const state = {
    steps: snapshot(), prompt: { source: 'creation_snapshot', prompt: 'CREATION_PROMPT' } as SessionSystemPrompt,
    requests: [] as string[], holdSteps: false, holdPrompt: false,
    heldSteps: undefined as Route | undefined, heldPrompt: undefined as Route | undefined,
  };
  // Registered after the broad workspace fixture: only these exact GET endpoints override it.
  await page.route(/\/v1\/sessions\/fixture-[01]\/(steps|system-prompt)$/, async route => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.fallback();
    state.requests.push(pathname);
    const oldSession = pathname.includes('/fixture-0/');
    if (pathname.endsWith('/steps')) {
      if (oldSession && state.holdSteps) { state.heldSteps = route; return; }
      return route.fulfill({ json: oldSession ? state.steps : {
        ...snapshot('fixture-1'), steps: [{ id: 'new-session', kind: 'user', content: [{ type: 'text', text: 'NEW_SESSION_ONLY' }], source: 'recorded', status: 'completed' }],
      } });
    }
    if (oldSession && state.holdPrompt) { state.heldPrompt = route; return; }
    return route.fulfill({ json: oldSession ? state.prompt : { source: 'live_effective', prompt: 'NEW_SESSION_PROMPT' } });
  });
  let sentEvents = false;
  await page.route(/\/v1\/sessions\/fixture-0\/events(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (sentEvents) return route.fulfill({ status: 204, body: '' });
    sentEvents = true;
    return route.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'text_delta', text: '隔离事件样例', requestId: 'inspection-fixture' },
      { type: 'completed', requestId: 'inspection-fixture' },
    ].map((event, i) => `id: ${i + 1}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
  });
  return { state, unexpected };
}
async function open(page: Page, count = 6) {
  await page.goto('/');
  if (page.viewportSize()!.width < 1180) await page.getByRole('button', { name: '打开工作区导航' }).click();
  await page.getByTestId('session-fixture-0').click();
  await page.getByTestId('composer-input').fill('sidebar draft');
  await page.getByTestId('trace-tab').click();
  await expect(page.getByRole('tab', { name: `步骤 ${count}` })).toHaveAttribute('aria-selected', 'true');
}
const row = (page: Page, id: string) => page.locator(`[data-step-id="${id}"]`);

for (const width of [1440, 1280, 390]) for (const theme of ['light', 'dark'] as const) {
  test(`metadata correction full App ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const { state, unexpected } = await fixture(page);
    const metadata = (id: string, label: string, content: unknown): SessionStep => ({ id, label, content, kind: 'system_event', status: 'completed', source: 'recorded', timestamp: '2026-01-01T15:33:44Z', omission: 'Only public entry fields shown; extension state omitted' });
    state.steps.steps = [
      metadata('model-1', 'model_change', { type: 'model_change', provider: 'openai', modelId: 'gpt-5.5', unknown: { nil: null, no: false, zero: 0, empty: '' } }),
      metadata('level-1', 'thinking_level_change', { type: 'thinking_level_change', thinkingLevel: 'medium' }),
      metadata('model-2', 'model_change', { type: 'model_change', provider: 'anthropic', modelId: 'claude-sonnet-4-6' }),
      metadata('level-2', 'thinking_level_change', { type: 'thinking_level_change', thinkingLevel: 'high' }),
      { ...metadata('system', 'system', { content: '', sections: { instructions: '系统分节原文 END_SYSTEM', removed: null }, toolsAdded: [], toolsRemoved: [], unknown: null }), omission: undefined },
      state.steps.steps[2], state.steps.steps[0], state.steps.steps[1], state.steps.steps[3],
      { ...state.steps.steps[4], status: 'error' }, state.steps.steps[5],
      { ...metadata('notice', 'notice', { type: 'notification', version: 1, notificationId: 'd78526a0-2ab7-4a54-9a16-402f92498f9a', runIds: ['run-1'], text: '已收到安全通知', entryId: 'notice', timestamp: '2026-01-01T15:33:44Z', unknown: '<img src="https://invalid.example/never-load">' }), kind: 'notification', omission: 'FUTURE_REASON_ORIGINAL' },
    ];
    await open(page, 12);
    const panel = page.getByTestId('inspector');
    await expect(page.getByTestId('session-step')).toHaveCount(12);
    const ids = state.steps.steps.map(step => step.id);
    expect(await page.getByTestId('session-step').evaluateAll(els => els.map(el => el.getAttribute('data-step-id')))).toEqual(ids);
    await expect(row(page, 'model-1').locator('pre')).toHaveText('openai / gpt-5.5');
    await expect(row(page, 'level-1').locator('pre')).toHaveText('medium');
    await expect(row(page, 'system').locator('pre')).toHaveText('instructions：系统分节原文 END_SYSTEM');
    await expect(panel.locator('.step-note')).toHaveCount(0);
    await expect(panel.locator('.steps-provenance')).toHaveCount(0);
    expect((await row(page, 'call-A').boundingBox())!.y).toBeLessThan(450);
    for (const pre of await panel.locator('.collapsed pre').all()) expect((await pre.textContent())!.trim().startsWith('{')).toBe(false);
    await mkdir('/tmp/pi-steps-reference-correction', { recursive: true });
    await page.screenshot({ path: `/tmp/pi-steps-reference-correction/${width}-${theme}.png` });
    const toggle = row(page, 'model-1').getByRole('button');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const value of ['"nil": null', '"no": false', '"zero": 0', '"empty": ""']) await expect(row(page, 'model-1').locator('pre')).toContainText(value);
    await expect(row(page, 'model-1')).toContainText('仅展示公开记录字段');
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await row(page, 'system').getByRole('button').click();
    await expect(row(page, 'system')).toContainText('END_SYSTEM');
    await row(page, 'result-B').getByRole('button').click();
    await expect(row(page, 'result-B')).toContainText('UNKNOWN_FIELD_END');
    await row(page, 'notice').getByRole('button').click();
    await expect(row(page, 'notice')).toContainText('FUTURE_REASON_ORIGINAL');
    await expect(panel.locator('img, iframe, a')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/pi-steps-reference-correction/${width}-${theme}-expanded-tail.png` });
    await expect(page.getByTestId('inspector-tab-steps')).toContainText('12');
    expect(await page.getByTestId('session-step').evaluateAll(els => els.map(el => el.getAttribute('data-step-id')))).toEqual(ids);
    expect(unexpected).toEqual([]);
  });
}

for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [1280, 'light'], [1280, 'dark'], [1100, 'light'], [1100, 'dark'], [390, 'light'], [390, 'dark']] as const) {
  test(`real App Inspector: ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const { state, unexpected } = await fixture(page);
    await open(page);
    await expect(page.getByTestId('app')).toHaveAttribute('data-theme', theme);
    const panel = page.getByTestId('inspector');
    expect((await panel.boundingBox())!.width).toBe(width <= 600 ? width : 380);
    await expect(page.locator('.workbench-inspector-backdrop, .workbench-drawer-backdrop')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width > 600) {
      const chat = (await page.getByTestId('chat').boundingBox())!;
      const side = (await panel.boundingBox())!;
      expect(chat.x + chat.width).toBe(side.x);
      expect(chat.width).toBe(width - (width >= 1180 ? 280 : 0) - 380);
      await page.getByTestId('composer-input').fill('sidebar draft');
      await expect(page.getByTestId('composer-input')).toBeFocused();
    } else {
      await expect(page.getByTestId('chat')).toBeHidden();
    }
    await expect(panel.getByRole('tab')).toHaveText(['步骤6', '系统提示词', '事件流']);
    expect(await page.getByTestId('session-step').evaluateAll(els => els.map(el => el.getAttribute('data-step-id'))))
      .toEqual(['thinking', 'call-B', 'call-A', 'result-B', 'result-A', 'active']);
    await row(page, 'thinking').getByRole('button').click();
    await expect(row(page, 'thinking')).toContainText('先核对 B，再核对 A');
    const toggle = row(page, 'thinking').getByRole('button');
    await page.mouse.move(0, 0);
    await toggle.evaluate(el => (el as HTMLElement).blur());
    const background = await toggle.evaluate(el => getComputedStyle(el).backgroundColor);
    await toggle.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    expect(await toggle.evaluate(el => el.matches(':focus-visible'))).toBe(true);
    await expect(toggle).toHaveCSS('outline-style', 'none');
    await expect(toggle).toHaveCSS('box-shadow', 'none');
    await expect(toggle).toHaveCSS('background-color', background);
    await expect(page.locator('.raw-footer, .tool-raw-footer, .tool-call-footer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /查看原始数据|复制原始数据|停止|stop/i })).toHaveCount(0);
    await expect(page.getByTestId('composer-mode')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /模式|mode|停止|stop|raw/i })).toHaveCount(0);
    await mkdir(evidence, { recursive: true });
    await expect(row(page, 'call-A').locator('pre')).toHaveText('用户原文：核对两个结果。\n保留用户换行。');
    await expect(row(page, 'result-B').locator('pre')).toHaveText(longContent);
    await page.screenshot({ path: `${evidence}/app-${width}-${theme}.png` });
    await row(page, 'call-A').getByRole('button').click();
    await expect(row(page, 'call-A')).toContainText('第二用户文本块');
    await expect(row(page, 'call-A')).toContainText('[omitted]');
    await page.screenshot({ path: `${evidence}/user-expanded-${width}-${theme}.png` });

    const chatScroll = await page.getByTestId('message-list').evaluate(el => el.scrollTop);
    const result = row(page, 'result-B');
    await result.getByRole('button').click();
    await expect(result.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    for (const part of [longContent, '第二结果文本块', '"count": 0', '"ok": false', '"empty": null', '"nestedCalls"', '嵌套结果', 'UNKNOWN_FIELD_END']) {
      await expect(result.locator('pre')).toContainText(part);
    }
    // Scroll the actual text endpoint into view, not merely a DOM text assertion.
    const end = await result.locator('pre').evaluateHandle(el => {
      const range = document.createRange();
      const start = el.textContent!.lastIndexOf('END_OF_INSPECTOR_RESULT');
      range.setStart(el.firstChild!, start);
      range.setEnd(el.firstChild!, start + 'END_OF_INSPECTOR_RESULT'.length);
      const body = el.closest('.inspector-body')!;
      body.scrollTop += range.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 24;
      return range;
    });
    expect(await end.evaluate(range => {
      const r = range.getBoundingClientRect();
      const body = document.querySelector('.inspector-body')!.getBoundingClientRect();
      return r.top >= body.top && r.bottom <= body.bottom && r.right <= innerWidth;
    })).toBe(true);
    await page.screenshot({ path: `${evidence}/long-end-${width}-${theme}.png` });
    await end.dispose();
    expect(await page.getByTestId('message-list').evaluate(el => el.scrollTop)).toBe(chatScroll);
    expect(await page.locator('.inspector-body').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await result.locator('pre').evaluate(el => {
      const body = el.closest('.inspector-body')!;
      body.scrollTop += el.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 24;
    });
    await page.screenshot({ path: `${evidence}/metadata-end-${width}-${theme}.png` });

    state.steps = snapshot('fixture-0', 2);
    state.steps.steps[5].content = 'ACTIVE_UPDATED_SAME_ID';
    await expect(row(page, 'active')).toContainText('ACTIVE_UPDATED_SAME_ID');
    await expect(page.getByTestId('session-step')).toHaveCount(6);
    await expect(result.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('inspector-tab-systemPrompt').click();
    await expect(panel).toContainText('创建时快照 · 不是实时运行值');
    await expect(panel).toContainText('CREATION_PROMPT');
    state.prompt = { source: 'live_effective', prompt: '' };
    await expect(panel).not.toContainText('当前有效提示词 · 不代表已发送给模型');
    await expect(panel).toContainText('空字符串（有效提示词）');
    await expect(panel.locator('.system-prompt-text')).toHaveText('');
    state.prompt = { source: 'live_effective', prompt: 'LIVE_PROMPT' };
    await expect(panel).not.toContainText('当前有效提示词 · 不代表已发送给模型');
    await expect(panel.locator('.system-prompt-text')).toHaveText('LIVE_PROMPT');
    state.prompt = { source: 'unavailable', prompt: null };
    await expect(panel).toContainText('系统提示词不可用');

    await page.getByTestId('inspector-tab-events').click();
    await expect(panel.locator('.event-type')).toContainText(['text_delta', 'completed']);
    await page.getByTestId('event-filter').selectOption('text_delta');
    await expect(panel.locator('.event-type')).toHaveText(['text_delta']);
    await page.getByTestId('event-filter').selectOption('all');
    await expect(panel.locator('.event-type')).toHaveCount(2);
    await page.getByTestId('event-clear').click();
    await expect(page.getByTestId('event-empty')).toBeVisible();

    await page.getByTestId('inspector-tab-steps').click();
    await expect(row(page, 'active')).toContainText('ACTIVE_UPDATED_SAME_ID');
    await page.getByTestId('inspector-close').click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('trace-tab')).toBeFocused();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toHaveValue('sidebar draft');
    const closedCount = state.requests.length;
    // More than both poll intervals: closing must not schedule either endpoint.
    await page.waitForTimeout(1250);
    expect(state.requests).toHaveLength(closedCount);
    state.steps = snapshot('fixture-0', 3);
    state.steps.steps.push({ id: 'unpersisted', kind: 'thinking', content: 'ACTIVE_NOT_IN_EXPORT', source: 'observed', status: 'streaming' });
    await page.getByTestId('trace-tab').click();
    await expect(page.getByRole('tab', { name: '步骤 7' })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'unpersisted')).toContainText('ACTIVE_NOT_IN_EXPORT');
    await expect(row(page, 'unpersisted')).toContainText('进行中');
    expect(await page.getByTestId('session-step').evaluateAll(els => els.map(el => el.getAttribute('data-step-id'))))
      .toEqual(['thinking', 'call-B', 'call-A', 'result-B', 'result-A', 'active', 'unpersisted']);
    expect(state.requests.length).toBeGreaterThan(closedCount);
    expect(unexpected).toEqual([]);
  });
}

test('sidebar width boundaries, mobile draft return and mock-only send', async ({ page }) => {
  const { unexpected } = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  for (const width of [320, 390, 600, 601, 768, 1179, 1180, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const side = (await page.getByTestId('inspector').boundingBox())!;
    expect(side.width).toBe(width <= 600 ? width : 380);
    expect(side.x + side.width).toBe(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width > 600) {
      const chat = (await page.getByTestId('chat').boundingBox())!;
      expect(chat.x + chat.width).toBe(side.x);
    }
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('trace-tab')).toBeFocused();
  await expect(page.getByTestId('composer-input')).toHaveValue('sidebar draft');
  await page.getByTestId('trace-tab').click();
  await page.getByTestId('inspector-close').click();
  await expect(page.getByTestId('trace-tab')).toBeFocused();
  await expect(page.getByTestId('composer-input')).toHaveValue('sidebar draft');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('trace-tab').click();
  const sent: unknown[] = [];
  await page.route('**/v1/sessions/fixture-0/messages', async route => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { status: 'accepted' } });
  });
  await page.getByTestId('composer-input').fill('mock sidebar send');
  await page.getByTestId('send-button').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ prompt: 'mock sidebar send' });
  await expect(page.getByTestId('inspector')).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('real App session switch rejects delayed steps and prompt responses', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { state, unexpected } = await fixture(page);
  await open(page);
  state.holdSteps = true;
  await expect.poll(() => !!state.heldSteps).toBe(true);
  await page.getByTestId('inspector-tab-systemPrompt').click();
  await expect(page.getByTestId('system-prompt-panel')).toContainText('CREATION_PROMPT');
  state.holdPrompt = true;
  await expect.poll(() => !!state.heldPrompt).toBe(true);
  // Closing preserves the existing in-flight response isolation check.
  await page.getByTestId('inspector-close').click();
  await page.getByTestId('session-fixture-1').click();
  await page.getByTestId('trace-tab').click();
  await page.getByTestId('inspector-tab-systemPrompt').click();
  await expect(page.getByTestId('inspector')).not.toContainText('CREATION_PROMPT');
  await state.heldPrompt!.fulfill({ json: { source: 'live_effective', prompt: 'STALE_PROMPT_MUST_NOT_RENDER' } });
  await expect(page.getByTestId('system-prompt-panel')).toContainText('NEW_SESSION_PROMPT');
  await page.getByTestId('inspector-tab-steps').click();
  await state.heldSteps!.fulfill({ json: { ...snapshot(), steps: [{ ...snapshot().steps[0], content: 'STALE_STEP_MUST_NOT_RENDER' }] } });
  await expect(page.getByTestId('session-step')).toHaveCount(1);
  await expect(page.getByTestId('session-step')).toContainText('NEW_SESSION_ONLY');
  await expect(page.getByTestId('inspector')).not.toContainText('STALE_');
  await page.waitForTimeout(1100);
  await expect(page.getByTestId('session-step')).toHaveCount(1);
  expect(unexpected).toEqual([]);
});
