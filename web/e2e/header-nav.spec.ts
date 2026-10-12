import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { workspaceFixture } from './workspace.fixture';

const evidence = '/tmp/pi-trace-toggle-final';
for (const width of [1440, 1280, 1100, 390]) for (const theme of ['light', 'dark'] as const) {
  test(`header navigation ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const unexpected = await workspaceFixture(page);
    let count = 0;
    let revision = 0;
    await page.route('**/v1/sessions/fixture-0/steps', route => route.fulfill({ json: {
      sessionId: 'fixture-0', projectionId: 'header-fixture', revision: ++revision,
      // Count always comes from the actual snapshot array.
      steps: Array.from({ length: count }, (_, i) => ({ id: `step-${i}`, kind: 'user', content: '隔离导航样例', source: 'recorded', status: 'completed' })),
    } }));
    await page.goto('/');
    if (width < 1180) await page.getByRole('button', { name: '打开工作区导航' }).click();
    await page.getByTestId('session-fixture-0').click();
    await mkdir(evidence, { recursive: true });
    const shot = (state: string) => page.screenshot({ path: `${evidence}/${width}-${theme}-${state}.png` });
    await expect(page.getByRole('button', { name: '轨迹', exact: true })).toBeVisible();
    const toggle = page.getByTestId('trace-tab');
    await expect(page.getByTestId('chat-tab')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).not.toHaveAttribute('aria-current');
    await expect(toggle).toHaveCSS('font-size', '12px');
    await page.mouse.move(0, 400);
    const toggleAppearance = () => toggle.evaluate(el => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.boxShadow, s.outlineStyle]; });
    const unfocused = await toggleAppearance();
    await toggle.focus();
    expect(await toggleAppearance()).toEqual(unfocused);
    if (width <= 640) expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot('closed');
    await page.getByTestId('trace-tab').click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('inspector')).toHaveAttribute('id', (await toggle.getAttribute('aria-controls'))!);
    if (width > 600) {
      await toggle.click();
      await expect(page.getByTestId('inspector')).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await toggle.click();
    }
    const tabs = page.locator('.inspector-tabs');
    await expect(page.getByRole('tab', { name: '步骤 0', exact: true })).toBeVisible();
    await shot('steps-empty');
    for (const value of [9, 0]) {
      count = value;
      await expect(page.getByRole('tab', { name: `步骤 ${value}`, exact: true })).toBeVisible();
      await expect(page.getByTestId('session-step')).toHaveCount(value);
      const geometry = await tabs.evaluate(el => {
        const buttons = [...el.querySelectorAll('button')];
        const ranges = buttons.map(button => { const range = document.createRange(); range.selectNodeContents(button.firstChild!); return range.getBoundingClientRect(); });
        const badge = el.querySelector('.tab-badge')!.getBoundingClientRect();
        const close = document.querySelector('[data-testid="inspector-close"]')!.getBoundingClientRect();
        return { tops: ranges.map(r => r.top), bottom: el.getBoundingClientRect().bottom,
          end: buttons.at(-1)!.getBoundingClientRect().right, close: close.left,
          badgeWidth: badge.width, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(Math.max(...geometry.tops) - Math.min(...geometry.tops)).toBeLessThan(1);
      expect(geometry.end).toBeLessThanOrEqual(geometry.close);
      expect(geometry.overflow).toBe(false);
      if (value === 9) {
        expect(geometry.badgeWidth).toBeLessThan(34);
        if (width > 600) expect(Math.abs((await page.getByTestId('chat-header').boundingBox())!.height - geometry.bottom)).toBeLessThan(1);
        await shot('open-steps');
      }
    }
    const prompt = page.getByTestId('inspector-tab-systemPrompt');
    await prompt.click();
    await page.mouse.move(0, 400);
    const appearance = () => prompt.evaluate(el => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.boxShadow, s.outlineStyle]; });
    const before = await appearance();
    await prompt.focus();
    expect(await appearance()).toEqual(before);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('inspector-tab-events')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByTestId('inspector-tab-steps')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('inspector-close').click();
    await expect(page.getByTestId('trace-tab')).toBeFocused();
    await page.getByTestId('trace-tab').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('trace-tab')).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Geometry-only long-title stress, keeping API/session data unchanged.
    await page.getByTestId('chat-session-title').evaluate(el => { el.textContent = '长标题换行验证：保留完整标题与两栏底线对齐。'.repeat(4); });
    await page.getByTestId('trace-tab').click();
    if (width > 600) await expect.poll(async () => Math.abs((await page.getByTestId('chat-header').boundingBox())!.height - (await tabs.boundingBox())!.height)).toBeLessThan(1);
    await shot('long-title');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(unexpected).toEqual([]);
    // Component-only header stress: real counts without 1447/99999 DOM rows.
    for (const count of [0, 9, 1447, 99999]) {
      await page.goto(`/visual-fixtures/steps.html?theme=${theme}&headerCount=${count}`);
      await expect(page.getByRole('tab', { name: `步骤 ${count}`, exact: true })).toBeVisible();
      await expect(page.getByTestId('session-step')).toHaveCount(0);
      const last = (await page.getByTestId('inspector-tab-events').boundingBox())!;
      const close = (await page.getByTestId('inspector-close').boundingBox())!;
      expect(last.x + last.width).toBeLessThanOrEqual(close.x);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (count === 1447 || count === 99999) await shot(`component-count-${count}`);
    }
  });
}
