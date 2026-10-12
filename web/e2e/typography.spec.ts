import { test, expect } from '@playwright/test';
import { workspaceFixture } from './workspace.fixture';
import { COMPOSER_VIEWPORT_CASES, FONT_SIZE } from './ui-expectations';

for (const viewport of COMPOSER_VIEWPORT_CASES) for (const theme of ['light', 'dark'] as const) {
  test(`seven-level typography ${viewport.name} ${theme}`, async ({ page }, info) => {
    const { width } = viewport;
    await page.setViewportSize({ width, height: viewport.height });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const unexpected = await workspaceFixture(page);
    const title = '隔离字体回归：长会话标题验证换行与列表省略，保留主要阅读字号 Typography；扩展长标题以验证桌面和手机都能完整阅读，不遮挡导航入口。';
    await page.route(/\/v1\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [{ id: 'fixture-0', projectId: 'fixture-project', title, createdAt: 1, updatedAt: Date.now(), modelProvider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'off', systemPrompt: null }] }));
    await page.route('**/export', route => route.fulfill({ json: { messages: [], lastEventId: 0, timeline: [
      { type: 'message', id: 'user', role: 'user', text: '隔离字体样例：正文保持 14px，不是实际执行记录。' },
      { type: 'thinking', id: 'thought', text: '检查字体角色与可读性，保留完整思考。' },
      { type: 'message', id: 'answer', role: 'assistant', text: '# 一级标题\n## 二级标题\n### 三级标题\n正文保持主要阅读层级，English 与中文使用本机字体。\n\n```ts\nconst longLine = "' + 'overflow-check-'.repeat(40) + '";\n```' },
      { type: 'tool_call', id: 'call', toolCallId: 'code', toolName: 'write', args: { path: '/fixture/type.ts', content: 'const parameter = "' + 'parameter-'.repeat(40) + '";' } },
      { type: 'tool_result', id: 'result', toolCallId: 'code', toolName: 'write', result: '```ts\nconst output = "' + 'output-'.repeat(40) + '";\n```', durationMs: 24, isError: false },
    ] } }));
    await page.goto('/');
    const navigation = page.getByRole('button', { name: '打开工作区导航' });
    if (await navigation.isVisible()) await navigation.click();
    await expect(page.locator('.brand-text')).toHaveCSS('font-size', `${FONT_SIZE.lg}px`);
    await expect(page.locator('.session-title')).toHaveCSS('font-size', `${FONT_SIZE.md}px`);
    await expect(page.locator('.session-date-group').first()).toHaveCSS('font-size', `${FONT_SIZE.sm}px`);
    await expect(page.locator('.workbench-project-select .select-menu-label')).toHaveCSS('font-size', `${FONT_SIZE.md}px`);
    await expect(page.locator('.session-time')).toHaveCSS('font-size', `${FONT_SIZE.xs}px`);
    await expect(page.getByTestId('new-session')).toHaveCSS('font-size', `${FONT_SIZE.baseSm}px`);
    await page.screenshot({ path: info.outputPath('navigation.png') });
    await page.getByTestId('session-fixture-0').click();
    await page.locator('.tool-call-header').click();
    await page.locator('.thinking-header').click();
    await expect(page.locator('.tool-result-text .tool-readable-value')).toHaveCSS('font-size', `${FONT_SIZE.baseSm}px`);
    await page.getByRole('button', { name: 'Markdown 展示', exact: true }).click();
    for (const [selector, size] of [
      ['.session-title-main', FONT_SIZE.sessionTitle], ['.user-bubble', FONT_SIZE.base], ['.assistant-content', FONT_SIZE.base],
      ['.thinking-body', FONT_SIZE.md], ['.tool-name', FONT_SIZE.md], ['.tool-summary-preview', FONT_SIZE.sm], ['.tool-duration', FONT_SIZE.xs],
      ['.composer textarea', FONT_SIZE.base], ['.model-thinking-trigger', FONT_SIZE.md], ['.trace-toggle', FONT_SIZE.baseSm],
      ['.assistant-content h1', FONT_SIZE.xl], ['.assistant-content h2', FONT_SIZE.lg], ['.assistant-content h3', FONT_SIZE.base],
      ['.tool-call-body > [aria-label="参数"] pre code', FONT_SIZE.sm],
      ['.tool-result-text pre code', FONT_SIZE.baseSm],
    ] as const) await expect(page.locator(selector).first()).toHaveCSS('font-size', `${size}px`);
    await expect(page.locator('.tool-name')).toHaveCSS('font-family', /SFMono-Regular.*monospace/);
    const composerBefore = await page.locator('.composer').boundingBox();
    await page.getByTestId('composer-input').fill('单行字体回归');
    await expect(page.getByTestId('composer-input')).toHaveValue('单行字体回归');
    expect(await page.locator('.composer').boundingBox()).toEqual(composerBefore);
    const bounds = await page.locator('.session-title-main').evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(bounds.height).toBeGreaterThan(bounds.line);
    for (const pre of await page.locator('pre:has(code)').all()) {
      expect(await pre.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      expect((await pre.boundingBox())!.width).toBeLessThan(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.locator('.chat-body').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('reading.png') });
    await page.locator('.tool-call-card, .tool-call').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('code.png') });
    await info.attach('computed-fonts', { body: JSON.stringify(await page.locator('.session-title-main, .user-bubble, .assistant-content, .thinking-body, .tool-name, .composer textarea').evaluateAll(els => els.map(el => ({ role: el.className, size: getComputedStyle(el).fontSize, family: getComputedStyle(el).fontFamily }))), null, 2), contentType: 'application/json' });
    expect(unexpected).toEqual([]);
  });
}
