import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, type Locator } from "@playwright/test";

/** Steps live inside a work block that folds once the run settles; open it like a reader would. */
async function revealStep(card: Locator) {
  const block = card.locator('xpath=ancestor::*[@data-testid="work-block"]');
  if (await block.getAttribute('data-expanded') === 'false') await block.locator('.work-header').click();
  await expect(card.locator('.tool-call-header')).toBeVisible();
}

async function checkHeaderIcons(card: Locator, name: string) {
  await revealStep(card);
  await card.scrollIntoViewIfNeeded();
  await card.page().mouse.move(0, 0);
  await expect(card.locator('.tool-status-icon')).toBeVisible();
  await expect(card.locator('.tool-status-icon')).toHaveCSS('opacity', '1');
  const geometry = await card.evaluate(el => {
    const rect = (selector: string) => el.querySelector(selector)!.getBoundingClientRect().toJSON();
    return { status: rect('.tool-status-icon'), name: rect('.tool-name'), header: rect('.tool-call-header') };
  });
  // The status glyph leads the name on the same line, and the whole row stays inside the step.
  expect(geometry.status.left).toBeGreaterThanOrEqual(geometry.header.left);
  expect(geometry.status.right).toBeLessThanOrEqual(geometry.name.left);
  expect(geometry.status.top).toBeLessThan(geometry.name.bottom);
  expect(geometry.status.bottom).toBeGreaterThan(geometry.name.top);
  expect(geometry.name.right).toBeLessThanOrEqual(geometry.header.right);
  await expect(card.locator('.tool-call-heading [data-icon="ellipsis"], .tool-call-category')).toHaveCount(0);
  await mkdir('/tmp/tool-icons-always/geometry', { recursive: true });
  await card.screenshot({ path: `/tmp/tool-icons-always/geometry/${name}.png` });
}
let server: Server;
let stream: ServerResponse | undefined;
let eventId = 0;
const session = { id: "00000000-0000-4000-8000-000000000096", projectId: "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c", title: "工具信息排版", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
const emit = (value: unknown) => stream!.write(`id: ${++eventId}\ndata: ${JSON.stringify(value)}\n\n`);
const result = (text: string) => ({ content: [{ type: "text", text }], details: { runIds: ["1", "2"], completeMetadata: true } });
const progress = '0/2 settled after 178s\nclaude-worker: 参考图已确认，正在校准真实 Web 的工具信息排版。\nworker: 保留完整原文、复制及流式更新，正在检查测试。';
const final = '2/2 background subagent(s) finished.\n\n## [claude-worker] run 1 — completed\n- 排版已检查，保留 `runIds` 与完整参数。\n\n## [worker] run 2 — completed\n- 实时进度、结果原文及 metadata 均可达。';
test.beforeAll(async () => {
  await mkdir('/tmp/tool-information-layout', { recursive: true });
  await mkdir('/tmp/tool-spacing-menu', { recursive: true });
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://fixture').pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/v1/access') return json({ canRead: true, canWrite: true });
    if (path === '/v1/projects') return json([{ id: session.projectId, name: '隔离验证', cwd: '/fixture', isDefault: true }]);
    if (path === '/v1/models') return json({ models: [], thinkingLevels: ['off'], defaultModel: null, defaultThinkingLevel: 'off' });
    if (path === '/v1/sessions') return json(req.method === 'POST' ? session : [], req.method === 'POST' ? 201 : 200);
    if (path.endsWith('/export')) return json({ lastEventId: 0, messages: [], timeline: [] });
    if (path.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.flushHeaders(); stream = res;
      req.on('close', () => { if (stream === res) stream = undefined; }); return;
    }
    if (path.endsWith('/messages')) { req.resume(); return json({ status: 'accepted' }, 202); }
    return json({ error: `Unexpected fixture path ${path}` }, 404);
  });
  await new Promise<void>(resolve => server.listen(8096, '127.0.0.1', resolve));
});
test.afterAll(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
// Visual glyph/hit-target and Markdown spacing/menu checks retain the full matrix.
for (const theme of ['dark', 'light']) for (const width of [1280, 390]) {
  test(`${theme} ${width}: subagent visible glyph insets and expanded body`, async ({ browser }) => {
    const dir = '/tmp/tool-block-icon-inset';
    await mkdir(dir, { recursive: true });
    const context = await browser.newContext({ hasTouch: width === 390, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto('/');
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await page.setViewportSize({ width, height: 950 });
    await page.getByTestId('composer-input').fill('检查参考 subagent 两端图标');
    await page.getByTestId('send-button').click();
    await expect.poll(() => !!stream).toBe(true);
    emit({ type: 'tool_start', toolCallId: 'optical-agent', toolName: 'subagent', args: { agent: 'worker', task: '只读任务：列出当前工作目录 /Users/mz/pi-default-project 下的所有文件，保留完整结果。' } });
    emit({ type: 'tool_end', toolCallId: 'optical-agent', toolName: 'subagent', result: result('检查完成'), isError: false });
    const card = page.locator('[data-tool-call-id="optical-agent"]');
    const header = card.locator('.tool-call-header');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await revealStep(card);
    await card.scrollIntoViewIfNeeded();
    const measure = () => card.evaluate(el => {
      const card = el.getBoundingClientRect();
      const glyph = (selector: string) => el.querySelector(selector)!.getBoundingClientRect().toJSON();
      return { width: card.width, status: glyph('.tool-status-icon'),
        name: el.querySelector('.tool-name')!.getBoundingClientRect().toJSON(),
        preview: el.querySelector('.tool-summary-preview')!.getBoundingClientRect().toJSON() };
    });
    await checkHeaderIcons(card, `${theme}-${width}-single`);
    const idle = await measure();
    await header.hover();
    await expect(card.locator('.tool-status-success')).toHaveCSS('opacity', '1');
    const hover = await measure();
    await writeFile(`${dir}/${theme}-${width}-glyph.json`, JSON.stringify(hover, null, 2));
    expect(hover).toEqual(idle);
    await expect(card.locator('.tool-summary-preview')).toHaveCSS('text-overflow', 'ellipsis');
    await page.screenshot({ path: `${dir}/${theme}-${width}-hover.png` });
    await card.screenshot({ path: `${dir}/${theme}-${width}-card.png` });
    await page.mouse.move(0, 0);
    await header.focus();
    expect(await measure()).toEqual(idle);
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const bounds = await card.boundingBox();
    await expect(card.getByTestId('tool-result-text')).toContainText('检查完成');
    await expect(card.locator('.tool-call-body > :not(section)')).toHaveCount(0);
    await page.screenshot({ path: `${dir}/${theme}-${width}-expanded.png` });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const body = await card.locator('.tool-call-body').boundingBox();
    // The expanded body stays inside its step.
    expect(body!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(body!.x + body!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await writeFile(`${dir}/${theme}-${width}-geometry.json`, JSON.stringify({ idle, hover, bounds }, null, 2));
    emit({ type: 'completed' });
    await context.close();
  });
  // Register only light desktop and dark mobile business representatives, not the full cross-product.
  if ((theme === 'light' && width === 1280) || (theme === 'dark' && width === 390)) {
  test(`${theme} ${width}: lightweight blocks in mixed actual App conversation`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: width === 390 });
    const page = await context.newPage();
    await mkdir('/tmp/tool-block-actual', { recursive: true });
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto('/');
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await page.setViewportSize({ width, height: 950 });
    await page.getByTestId('composer-input').fill('你测试一下 subagent，并检查工具呈现');
    await page.getByTestId('send-button').click();
    await expect.poll(() => !!stream).toBe(true);
    emit({ type: 'text_delta', text: '我先看看有哪些可用的子代理，然后启动一个简单的任务。' });
    emit({ type: 'thinking_delta', text: '检查可用代理，保留工具调用的真实时间顺序。' });
    emit({ type: 'tool_start', toolCallId: 'mixed-bash', toolName: 'bash', args: { command: 'ls -la .pi/agents' } });
    const bash = page.locator('[data-tool-call-id="mixed-bash"]');
    // Steps start collapsed while running; open this one to read its live output.
    await expect(bash.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
    await bash.locator('.tool-call-header').click();
    emit({ type: 'tool_update', toolCallId: 'mixed-bash', toolName: 'bash', partialResult: result('worker.md') });
    await expect(bash.getByTestId('tool-result-text')).toContainText('worker.md');
    await expect(bash.getByTestId('tool-name')).toHaveText('bash');
    await page.screenshot({ path: `/tmp/tool-block-actual/${theme}-${width}-streaming.png` });
    emit({ type: 'tool_end', toolCallId: 'mixed-bash', toolName: 'bash', result: result('worker.md'), isError: false });
    await expect(bash).toHaveAttribute('data-done', 'true');
    await bash.locator('.tool-call-header').click();
    await expect(bash.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
    emit({ type: 'text_delta', text: '.pi/agents 里有 worker。接下来检查排版与完整结果。' });
    emit({ type: 'tool_start', toolCallId: 'mixed-agent', toolName: 'subagent', args: { agent: 'worker', task: '检查轻量工具块与正文的信息层级' } });
    emit({ type: 'tool_end', toolCallId: 'mixed-agent', toolName: 'subagent', result: result('Started run 1'), isError: false });
    emit({ type: 'tool_start', toolCallId: 'mixed-wait', toolName: 'subagent_wait', args: { runIds: ['1'], timeoutMs: 600000 } });
    emit({ type: 'tool_update', toolCallId: 'mixed-wait', toolName: 'subagent_wait', partialResult: result('0/1 settled\nworker: 正在检查明暗主题与长参数。') });
    const wait = page.locator('[data-tool-call-id="mixed-wait"]');
    await expect(wait.getByTestId('tool-name')).toHaveText('subagent_wait');
    // A running subagent_wait starts closed; its summary line carries the progress.
    await expect(wait.locator('.tool-summary-preview')).toContainText('0/1 settled');
    await page.screenshot({ path: `/tmp/tool-block-actual/${theme}-${width}-conversation.png` });
    const header = wait.locator('.tool-call-header');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    // Opened by keyboard while running, it stays open through completion.
    await header.focus(); await page.keyboard.press('Space');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    emit({ type: 'tool_end', toolCallId: 'mixed-wait', toolName: 'subagent_wait', result: result('检查完成，完整原文与 metadata 保留。'), isError: false });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(wait.getByTestId('tool-result-text')).toContainText('检查完成');
    await expect(wait.locator('.tool-call-body > :not(section)')).toHaveCount(0);
    await wait.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/tool-block-actual/${theme}-${width}-expanded.png` });
    if (width === 390) {
      await expect(wait.locator('.tool-status-icon')).toHaveCSS('opacity', '1');
    }
    const name = 'unknown_extension_' + 'long_tool_name_'.repeat(12);
    emit({ type: 'tool_start', toolCallId: 'mixed-long', toolName: name, args: { nested: { values: [false, 0, null] } } });
    emit({ type: 'tool_end', toolCallId: 'mixed-long', toolName: name, result: { content: [{ type: 'unknown', retained: true }] }, isError: false });
    const long = page.locator('[data-tool-call-id="mixed-long"]');
    await expect(long.getByTestId('tool-name')).toHaveText(name);
    await revealStep(long);
    await long.locator('.tool-call-header').click();
    await expect(long.getByRole('region', { name: '结果', exact: true })).toBeVisible();
    expect(await long.getByTestId('tool-name').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await checkHeaderIcons(long, `${theme}-${width}-long`);
    await long.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/tool-block-actual/${theme}-${width}-long-unknown.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    emit({ type: 'completed' });
    await context.close();
  });
  test(`${theme} ${width}: App HTTP/SSE compact parameters, streaming and complete output`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto('/');
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await page.setViewportSize({ width, height: 950 });
    await page.getByTestId('composer-input').fill('检查工具的信息排版');
    await page.getByTestId('send-button').click();
    await expect.poll(() => !!stream).toBe(true);
    emit({ type: 'tool_start', toolCallId: 'wait', toolName: 'subagent_wait', args: { runIds: ['1', '2'], timeoutMs: 600000 } });
    const card = page.locator('[data-tool-call-id="wait"]');
    // A running subagent_wait starts closed: the live subagent panel shows its progress. Open it by hand to read the raw progress.
    await expect(card.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
    await card.locator('.tool-call-header').click();
    emit({ type: 'tool_update', toolCallId: 'wait', toolName: 'subagent_wait', partialResult: result(progress) });
    await expect(card.getByTestId('tool-result-text')).toHaveText(progress);
    await expect(card.getByRole('region', { name: '参数', exact: true })).toContainText('["1","2"]');
    await expect(card.locator('.tool-parameter-items')).toHaveCount(0);
    await expect(card.locator('.json-label')).toHaveCount(0);
    await expect(card.locator('.tool-summary-preview')).toContainText('runIds=["1","2"]');
    await page.screenshot({ path: `/tmp/tool-information-layout/${theme}-${width}-progress.png` });
    emit({ type: 'tool_update', toolCallId: 'wait', toolName: 'subagent_wait', partialResult: result(progress.replace('0/2', '1/2').replace('178s', '179s')) });
    await expect(card.getByTestId('tool-result-text')).toContainText('1/2 settled after 179s');
    emit({ type: 'tool_end', toolCallId: 'wait', toolName: 'subagent_wait', result: result(final), isError: false });
    // Opened by hand, it stays open through completion.
    await expect(card.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByRole('heading', { name: '[worker] run 2 — completed' })).toBeVisible();
    await page.screenshot({ path: `/tmp/tool-information-layout/${theme}-${width}-result.png` });
    await card.getByRole('button', { name: 'Markdown 展示' }).click();
    await expect(card.getByTestId('tool-result-text')).toHaveText(final);
    await card.locator('.tool-call-header').click();
    const cases = [
      ['single', 'subagent', { agent: 'worker', task: '保留比例字体，检查工具正文。\n不照搬终端外观。', cwd: '/fixture' }, result('## 检查完成\n- 保留完整内容')],
      ['parallel', 'subagent', { tasks: [{ agent: 'scout', task: '检查源文件' }, { agent: 'worker', task: '检查布局与长文本\n保留全部字段' }] }, result('## 并行结果\n- 两个代理已返回')],
      ['shell', 'bash', { command: "printf 'first\\nsecond\\n'", timeout: 0 }, result('first\nsecond\n')],
      ['read', 'read', { path: '/fixture/a.ts' }, result('export const value = 1;\n')],
      ['write', 'write', { path: '/fixture/a.ts', content: 'export const value = 2;\n' }, result('written')],
      ['edit', 'edit', { path: '/fixture/a.ts', oldText: 'const value = 1;\n', newText: 'const value = 2;\n' }, result('edited')],
      ['unknown', 'custom_unknown', { flags: [0, false, null], nested: { message: '<script>not executable</script>' } }, { content: [{ type: 'custom', payload: { retained: true } }], metadata: { trace: 'complete' } }],
    ] as const;
    for (const [id, toolName, args, output] of cases) {
      emit({ type: 'tool_start', toolCallId: id, toolName, args });
      const item = page.locator(`[data-tool-call-id="${id}"]`);
      await expect(item.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
      // Opened by hand, it stays open through tool_end.
      await item.locator('.tool-call-header').click();
      emit({ type: 'tool_end', toolCallId: id, toolName, result: output, isError: false });
      await expect(item).toHaveAttribute('data-done', 'true');
      await expect(item.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'true');
      await item.scrollIntoViewIfNeeded();
      if (id === 'parallel') await checkHeaderIcons(item, `${theme}-${width}-parallel`);
      await page.screenshot({ path: `/tmp/tool-information-layout/${theme}-${width}-${id}.png` });
      await expect(item.getByRole('region', { name: '结果', exact: true })).toBeVisible();
      await item.locator('.tool-call-header').click();
      if (id === 'parallel') await checkHeaderIcons(item, `${theme}-${width}-parallel-collapsed`);
    }
    emit({ type: 'completed' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  }
  test(`${theme} ${width}: adjacent Markdown blocks without extra footer`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto('/');
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await page.setViewportSize({ width, height: 1100 });
    await page.getByTestId('composer-input').fill('工具块间距隔离检查');
    await page.getByTestId('send-button').click();
    await expect.poll(() => !!stream).toBe(true);
    const text = '命令：\n\n```bash\npwd\n```\n\n原始输出：\n\n```text\n/fixture\n```\n\n连续段落一。\n\n连续段落二。\n\n### 列表层级\n\n- 列表说明\n\n  ```js\n  const nested = true;\n  ```\n\n  列表尾段。\n\n> 引用首段。\n>\n> ```text\n> quoted\n> ```\n>\n> 引用尾段。';
    emit({ type: 'tool_start', toolCallId: 'spacing', toolName: 'subagent_wait', args: { runIds: ['1'] } });
    emit({ type: 'tool_end', toolCallId: 'spacing', toolName: 'subagent_wait', result: result(text), isError: false });
    const card = page.locator('[data-tool-call-id="spacing"]');
    await expect(card.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
    await card.locator('.tool-call-header').click();
    const markdown = card.locator('.markdown');
    await expect(markdown.locator('.code-block')).toHaveCount(4);
    const geometry = await markdown.evaluate(el => {
      const gap = (a: Element, b: Element) => b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
      const blocks = Array.from(el.children);
      const nested = Array.from(el.querySelector('li')!.children);
      const quoted = Array.from(el.querySelector('blockquote')!.children);
      return { gaps: blocks.slice(1).map((b, i) => gap(blocks[i], b)),
        nestedGaps: nested.slice(1).map((b, i) => gap(nested[i], b)),
        quotedGaps: quoted.slice(1).map((b, i) => gap(quoted[i], b)),
        start: blocks[0].getBoundingClientRect().top - el.getBoundingClientRect().top,
        end: el.getBoundingClientRect().bottom - blocks.at(-1)!.getBoundingClientRect().bottom };
    });
    expect(geometry.gaps).toEqual([12, 12, 12, 12, 12, 24, 8, 12]);
    expect(geometry.nestedGaps).toEqual([12, 12]);
    expect(geometry.quotedGaps).toEqual([12, 12]);
    expect(geometry.start).toBe(0); expect(geometry.end).toBe(0);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/tool-spacing-menu/${theme}-${width}-spacing.png` });
    await expect(card.locator('.tool-call-body > :not(section)')).toHaveCount(0);
    await expect(card.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'true');
    await card.locator('.tool-call-header').click();
    for (const [id, source] of [
      ['code-edges', '```text\nfirst\n```\n\n段落\n\n```text\nlast\n```'],
      ['heading-edges', '###### 首标题\n\n段落\n\n---\n\n尾段'],
      ['tight-list', '- 紧凑列表\n  ```text\n  nested\n  ```\n  - 嵌套列表\n    ```text\n    deeper\n    ```'],
    ]) {
      emit({ type: 'tool_start', toolCallId: id, toolName: 'subagent_wait', args: {} });
      emit({ type: 'tool_end', toolCallId: id, toolName: 'subagent_wait', result: result(source), isError: false });
      const edgeCard = page.locator(`[data-tool-call-id="${id}"]`);
      await expect(edgeCard.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
      await edgeCard.locator('.tool-call-header').click();
      const mode = edgeCard.getByRole('button', { name: 'Markdown 展示' });
      if (await mode.getAttribute('aria-pressed') === 'false') await mode.click();
      const edge = edgeCard.locator('.markdown');
      await expect(edge).toBeVisible();
      const margins = await edge.evaluate(el => ({ first: getComputedStyle(el.firstElementChild!).marginTop, last: getComputedStyle(el.lastElementChild!).marginBottom }));
      expect(margins).toEqual({ first: '0px', last: '0px' });
      if (id === 'tight-list') {
        const gaps = await edge.locator('li > .code-block').evaluateAll(blocks => blocks.map(el => {
          const range = document.createRange(); range.selectNode(el.parentElement!.firstChild!);
          return el.getBoundingClientRect().top - range.getBoundingClientRect().bottom;
        }));
        expect(gaps).toHaveLength(2);
        gaps.forEach(gap => expect(gap).toBeGreaterThanOrEqual(12));
      }
      await edgeCard.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/tool-spacing-menu/${theme}-${width}-${id}.png` });
      await edgeCard.locator('.tool-call-header').click();
    }
    await writeFile(`/tmp/tool-spacing-menu/${theme}-${width}-geometry.json`, JSON.stringify({ geometry }, null, 2));
    emit({ type: 'completed' });
  });
}
