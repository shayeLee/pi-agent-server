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
      await page.goto('http://127.0.0.1:5189');
      const composer = page.getByTestId('composer');
      await expect(page.getByTestId('model-thinking-trigger')).toBeVisible();
      const box = (selector: string) => page.locator(selector).boundingBox();
      const app = await box('.app-shell');
      expect(app!.x).toBe(0);
      expect(app!.width).toBe(viewport.width);
      const start = (await composer.boundingBox())!;
      const hint = (await page.getByTestId('no-session-hint').boundingBox())!;
      expect(start.width).toBeLessThanOrEqual(1200);
      expect(hint.x + hint.width / 2).toBeCloseTo(start.x + start.width / 2, 0);
      expect(start.y - hint.y - hint.height).toBeGreaterThanOrEqual(0);
      expect(start.y - hint.y - hint.height).toBeLessThanOrEqual(24);
      if (viewport.width >= 1180) expect((await box('aside.sidebar'))!.x).toBe(0);
      const prefix = `/tmp/widescreen-layout/${viewport.width}x${viewport.height}-dpr${viewport.dpr}-${theme}`;
      await page.screenshot({ path: `${prefix}-start.png` });
      if (viewport.width < 1180) await page.getByRole('button', { name: '打开工作区导航' }).click();
      await page.getByTestId('session-wide-session').click();
      await expect(page.getByTestId('message-list')).toContainText('正文与输入区域');
      const assertAxis = async () => {
        const reading = (await box('.chat-inner'))!;
        const input = (await composer.boundingBox())!;
        expect(reading.width).toBeLessThanOrEqual(1248);
        expect(reading.x + reading.width / 2).toBeCloseTo(input.x + input.width / 2, 0);
        // Compare transcript content (excluding its responsive padding) to Composer.
        const readingPadding = await page.locator('.chat-inner').evaluate(element => {
          const style = getComputedStyle(element);
          return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        });
        expect(reading.width - readingPadding).toBeCloseTo(input.width, 0);
        expect(Math.abs(input.y - start.y)).toBeLessThan(48);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await assertAxis();
      await page.screenshot({ path: `${prefix}-session.png` });
      await page.getByTestId('trace-tab').click();
      await expect(page.getByTestId('inspector')).toBeVisible();
      await assertAxis();
      await page.screenshot({ path: `${prefix}-inspector.png` });
      await context.close();
    });
  }
}
