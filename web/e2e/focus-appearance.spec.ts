import { test, expect } from '@playwright/test';
import { workspaceFixture } from './workspace.fixture';
import { appearance } from './focus-appearance';

const FOCUS_DESKTOP_VIEWPORT = { width: 1536, height: 1024 }; // Spacious desktop; no drawer or toolbar wrapping.

for (const theme of ['light', 'dark'] as const) {
  test(`focus has no visual effect ${theme}`, async ({ page }) => {
    const unexpected = await workspaceFixture(page);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.setViewportSize(FOCUS_DESKTOP_VIEWPORT);
    await page.goto('/');
    await page.getByTestId('session-fixture-0').click();
    await page.mouse.move(FOCUS_DESKTOP_VIEWPORT.width / 2, 0); // Park outside controls to remove hover.
    const textarea = page.getByTestId('composer-input');
    const header = page.locator('.tool-call-header').first();
    const targets = [
      { target: textarea, root: textarea, name: 'textarea' },
      { target: header, root: page.locator('.tool-call-heading').first(), name: 'toolheading' },
      { target: page.getByTestId('session-fixture-0'), root: page.locator('.session-item').filter({ has: page.getByTestId('session-fixture-0') }), name: 'session' },
      { target: page.getByTestId('model-thinking-trigger'), root: page.getByTestId('model-thinking-trigger'), name: 'model' },
    ];
    for (const { target, root, name } of targets) {
      await target.evaluate(el => (el as HTMLElement).blur());
      const before = await appearance(root);
      await page.keyboard.press('Tab');
      await target.focus();
      await expect(target).toBeFocused();
      expect(await appearance(root)).toEqual(before);
      await page.screenshot({ path: `test-results/workspace/focus-${theme}-${name}.png` });
    }
    await header.focus();
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await textarea.fill('isolated draft');
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('isolated draft');
    expect(unexpected).toEqual([]);
  });
}
