import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
let server: Server;
let stream: ServerResponse | undefined;
let eventId = 0;
const dir = '/tmp/subagent-parallel-ui';
const session = { id: '00000000-0000-4000-8000-000000000097', projectId: '6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c', title: '并行代理隔离验证', createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
const emit = (value: unknown) => stream!.write(`id: ${++eventId}\ndata: ${JSON.stringify(value)}\n\n`);
test.beforeAll(async () => {
  await mkdir(dir, { recursive: true });
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://fixture').pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/v1/access') return json({ canRead: true, canWrite: true });
    if (path === '/v1/projects') return json([{ id: session.projectId, name: '隔离验证', cwd: '/fixture', isDefault: true }]);
    if (path === '/v1/models') return json({ models: [], thinkingLevels: ['off'], defaultModel: null, defaultThinkingLevel: 'off' });
    if (path === '/v1/sessions') return json(req.method === 'POST' ? session : [], req.method === 'POST' ? 201 : 200);
    if (path.endsWith('/export')) return json({ lastEventId: 0, messages: [], timeline: [] });
    if (path.endsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); stream = res; req.on('close', () => { if (stream === res) stream = undefined; }); return; }
    if (path.endsWith('/messages')) { req.resume(); return json({ status: 'accepted' }, 202); }
    return json({ error: path }, 404);
  });
  await new Promise<void>(resolve => server.listen(8097, '127.0.0.1', resolve));
});
test.afterAll(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const longName = 'worker-with-a-very-long-agent-name-'.repeat(5);
const cases = [
  ['two', { tasks: [{ agent: 'lite', task: '只读任务：列出当前目录所有文件与子目录，保留完整原文。'.repeat(5), cwd: '/fixture/one' }, { agent: 'worker', task: '检查布局与长文本。\n请保留任务顺序，不修改任何文件。'.repeat(4), cwd: '/fixture/two', flags: { safe: false, count: 0 } }], agentScope: 'both' }, 2],
  ['three', { tasks: [{ agent: 'lite', task: '第一项' }, { agent: 'lite', task: '第二项' }, { agent: longName, task: '第三项\n保留完整名字', cwd: '/fixture/three' }] }, 3],
  ['single', { agent: 'lite', task: '单代理保持现样', cwd: '/fixture' }, 0],
  ['one', { tasks: [{ agent: 'worker', task: '数组只有一项' }] }, 0],
  ['empty', { tasks: [] }, 0],
  ['invalid', { tasks: [{ agent: 'lite', task: 'valid item' }, null, { agent: 3, task: false }] }, 0],
  ['invalid-object', { tasks: { agent: 'lite', task: '不是数组' } }, 0],
] as const;
// Business flow representatives: light desktop and dark mobile, not the full cross-product.
for (const { theme, width } of [{ theme: 'light', width: 1280 }, { theme: 'dark', width: 390 }] as const) test(`${theme} ${width} actual App parallel tasks`, async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: width === 390, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  if (await page.getByTestId('app').getAttribute('data-theme') !== theme) await page.getByTestId('theme-toggle').click();
  await page.setViewportSize({ width, height: 1000 });
  await page.getByTestId('composer-input').fill('检查并行代理');
  await page.getByTestId('send-button').click();
  await expect.poll(() => !!stream).toBe(true);
  for (const [id, args, count] of cases) {
    const output = '2 background subagent(s) started:\n  runId: 1 — lite\n  runId: 2 — worker\n\nCall subagent_wait to collect their results.';
    const result = { content: [{ type: 'text', text: output }], details: { untouched: true } };
    emit({ type: 'tool_start', toolCallId: id, toolName: 'subagent', args });
    const card = page.locator(`[data-tool-call-id="${id}"]`);
    const header = card.locator('.tool-call-header');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    emit({ type: 'tool_end', toolCallId: id, toolName: 'subagent', result, isError: false });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.tool-parallel-count')).toHaveCount(count ? 1 : 0);
    if (count) {
      await expect(card.locator('.tool-parallel-count')).toHaveText(`并行 ${count}`);
      const tasks = (args as typeof cases[0][1]).tasks;
      await expect(card.locator('.tool-parallel-names')).toHaveText(tasks.map(t => t.agent).join('、'));
      const geometry = await header.evaluate(el => {
        const rect = (selector: string) => el.querySelector(selector)!.getBoundingClientRect().toJSON();
        const names = el.querySelector('.tool-parallel-names')!;
        const count = el.querySelector('.tool-parallel-count')!;
        return { header: el.getBoundingClientRect().toJSON(), name: rect('.tool-name'), count: rect('.tool-parallel-count'), names: rect('.tool-parallel-names'), namesFit: names.scrollWidth <= names.clientWidth, countFit: count.scrollWidth <= count.clientWidth };
      });
      expect(geometry.countFit).toBe(true);
      expect(geometry.count.x).toBeGreaterThanOrEqual(geometry.name.right);
      expect(geometry.count.right).toBeLessThanOrEqual(geometry.header.right);
      if (id === 'two') expect(geometry.namesFit).toBe(true);
      await writeFile(`${dir}/${theme}-${width}-${id}-geometry.json`, JSON.stringify(geometry, null, 2));
    }
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${theme}-${width}-${id}-collapsed.png` });
    await header.click();
    await expect(card.getByTestId('tool-result-text')).toHaveText(output);
    if (count || id === 'one') {
      const tasks = (args as typeof cases[0][1]).tasks;
      const items = card.locator('.tool-parallel-tasks > li');
      await expect(items).toHaveCount(tasks.length);
      await expect(card.locator('dt').filter({ hasText: /^tasks$/ })).toHaveCount(0);
      for (let i = 0; i < tasks.length; i++) {
        await expect(items.nth(i).locator('.tool-subagent-agent')).toHaveText(tasks[i].agent);
        expect(await items.nth(i).locator('pre').first().textContent()).toBe(tasks[i].task);
      }
      if (count) {
        const group = await items.nth(1).evaluate(el => ({ border: getComputedStyle(el).borderTopWidth, gap: getComputedStyle(el).marginTop, padding: getComputedStyle(el).paddingTop }));
        expect(group).toEqual({ border: '1px', gap: '8px', padding: '8px' });
      }
    }
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${theme}-${width}-${id}-expanded.png` });
    await card.screenshot({ path: `${dir}/${theme}-${width}-${id}-card.png` });
    await card.getByRole('button', { name: '工具更多操作' }).click();
    await card.getByRole('menuitem', { name: '查看原始数据' }).click();
    const raw = JSON.parse((await page.getByRole('dialog').locator('pre').textContent())!);
    expect(raw.args).toEqual(args); expect(raw.result).toEqual(result);
    if (id === 'two') await page.screenshot({ path: `${dir}/${theme}-${width}-raw.png` });
    await page.getByRole('dialog').getByRole('button', { name: '复制原始数据' }).click();
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(raw);
    await page.keyboard.press('Escape');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    // A later snapshot must not override the manual expansion.
    emit({ type: 'tool_end', toolCallId: id, toolName: 'subagent', result, isError: false });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await header.click();
  }
  emit({ type: 'completed' });
  await context.close();
});
