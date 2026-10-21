import { test, expect } from '@playwright/test';

const session = { id: 'wide-session', projectId: 'wide-project', title: '布局核验', createdAt: 1700000000000, updatedAt: 1700000000000, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
for (const viewport of [{ width: 1920, height: 871, dpr: 2 }, { width: 2470, height: 780, dpr: 1 }, { width: 1280, height: 800, dpr: 1 }, { width: 390, height: 844, dpr: 1 }]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.width}x${viewport.height} ${theme}: full viewport and stable reading axis`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.dpr, colorScheme: theme });
      const page = await context.newPage();
      await page.route('**/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (path === '/v1/access') return json({ canRead: true, canWrite: true });
        if (path === '/v1/projects') return json([{ id: 'wide-project', name: '默认项目', cwd: '/tmp/fixture', isDefault: true }]);
        if (path === '/v1/models') return json({ models: [{ provider: 'fixture', id: 'fixture-model' }], defaultModel: { provider: 'fixture', id: 'fixture-model' }, thinkingLevels: ['off', 'high'], defaultThinkingLevel: 'high' });
        if (path === '/v1/sessions') return json([session]);
        if (path.endsWith('/export')) return json({ timeline: [{ type: 'message', id: 'u', role: 'user', text: '保持舒适的阅读宽度。' }, { type: 'message', id: 'a', role: 'assistant', text: '正文与输入区域保持同轴，额外空间留在主区两侧。' }], messages: [], lastEventId: 0 });
        return route.fulfill({ status: 204, body: '' });
      });
      await page.goto('/');
      const composer = page.getByTestId('composer');
      await expect(page.getByTestId('model-thinking-trigger')).toBeVisible();
      const box = (selector: string) => page.locator(selector).boundingBox();
      const app = await box('.app-shell');
      expect(app!.x).toBe(0);
      expect(app!.width).toBe(viewport.width);
      const start = (await composer.boundingBox())!;
      const welcome = (await page.getByTestId('companion-welcome').boundingBox())!;
      // The blank-session welcome is centred on the Composer's column and sits above it.
      expect(Math.abs(welcome.x + welcome.width / 2 - (start.x + start.width / 2))).toBeLessThan(1);
      expect(start.y).toBeGreaterThanOrEqual(welcome.y + welcome.height);
      if (viewport.width >= 1180) expect((await box('aside.sidebar'))!.x).toBe(0);
      const prefix = `/tmp/widescreen-layout/${viewport.width}x${viewport.height}-dpr${viewport.dpr}-${theme}`;
      await page.screenshot({ path: `${prefix}-start.png` });
      if (viewport.width < 1180) await page.getByRole('button', { name: '打开工作区导航' }).click();
      await page.getByTestId('session-wide-session').click();
      await expect(page.getByTestId('message-list')).toContainText('正文与输入区域');
      const assertAxis = async () => {
        const input = (await composer.boundingBox())!;
        // Transcript content column and Composer share one left edge; extra width stays on the right.
        const content = (await page.locator('.ledger-entry .ledger-body').first().boundingBox())!;
        expect(Math.abs(content.x - input.x)).toBeLessThan(1);
        expect(input.x + input.width).toBeLessThanOrEqual(viewport.width);
        // The content column is centred in the chat area whenever the area is wide enough for it.
        const chat = (await page.locator('.chat').first().boundingBox())!;
        const fits = await page.locator('.chat').first().evaluate(el => {
          const probe = document.createElement('div');
          probe.style.width = 'calc(var(--ledger-max) + var(--ledger-offset) + 2 * var(--reading-inline-inset))';
          el.append(probe); const needed = probe.getBoundingClientRect().width; probe.remove();
          return el.getBoundingClientRect().width >= needed;
        });
        if (viewport.width >= 1920) expect(fits).toBe(true);
        if (fits) expect(Math.abs(content.x + content.width / 2 - (chat.x + chat.width / 2))).toBeLessThan(1);
        if (viewport.width >= 1180) {
          // The header sits on the ledger's column: title at the entries' left edge (the time gutter, or the
          // merged tag row in the compact ledger), actions at the Composer's right edge.
          const title = (await page.getByTestId('chat-session-title').boundingBox())!;
          const gutter = (await page.locator('.ledger-entry').first().boundingBox())!;
          const actions = (await page.locator('.chat-header-actions').boundingBox())!;
          expect(Math.abs(title.x - gutter.x)).toBeLessThan(1);
          expect(Math.abs(actions.x + actions.width - (input.x + input.width))).toBeLessThan(1);
        }

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await assertAxis();
      // From TRACE_DEFAULT_MIN_WIDTH (App.tsx, 1500px) the trace opens with the
      // session on Subagents and the column re-centres; elsewhere opening a session moves nothing.
      const traceByDefault = viewport.width >= 1500;
      await expect(page.getByTestId('inspector')).toHaveCount(traceByDefault ? 1 : 0);
      if (traceByDefault) await expect(page.getByTestId('inspector-tab-subagents')).toHaveAttribute('aria-selected', 'true');
      else expect(Math.abs((await composer.boundingBox())!.x - start.x)).toBeLessThan(1);
      await page.screenshot({ path: `${prefix}-session.png` });
      if (!traceByDefault) await page.getByTestId('trace-tab').click();
      await expect(page.getByTestId('inspector')).toBeVisible();
      await assertAxis();
      await page.screenshot({ path: `${prefix}-inspector.png` });
      await context.close();
    });
  }
}
