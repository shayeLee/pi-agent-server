import { test, expect, type Page } from '@playwright/test';
import { workspaceFixture } from './workspace.fixture';
import { COMPOSER_VIEWPORT_CASES } from './ui-expectations';
import { expectNonOverlapping, expectUsableControl } from './usable-control';

const LONG_DRAFT_LINE_COUNT = 30; // Enough content to require editor scrolling.
async function expectContainedComposer(page: Page) {
  expect(await page.locator('.composer').evaluate(el => {
    const parent = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll('textarea, .composer-toolbar, .composer-toolbar button')).every(child => {
      const box = child.getBoundingClientRect();
      return box.left >= parent.left && box.right <= parent.right && box.top >= parent.top && box.bottom <= parent.bottom
        && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    });
  })).toBe(true);
  await expectNonOverlapping(page.locator('.composer'), page.getByTestId('chat-body'));
}
for (const viewport of COMPOSER_VIEWPORT_CASES) for (const theme of ['light', 'dark'] as const) {
  for (const state of ['new-session', 'selected-session'] as const) {
    test(`composer geometry ${viewport.name} ${theme} ${state}`, async ({ page }, info) => {
      const unexpected = await workspaceFixture(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('/');
      const navigation = page.getByRole('button', { name: '打开工作区导航' });
      if (await navigation.isVisible()) await navigation.click();
      await page.getByTestId(state === 'new-session' ? 'new-session' : 'session-fixture-0').click();
      if (state === 'selected-session') {
        await expect(page.getByTestId('stats-bar')).toBeVisible();
      }
      const input = page.getByTestId('composer-input');
      await expect(input).toHaveValue('');
      await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
      await expect(page.getByTestId('model-thinking-trigger')).toContainText('fixture-model');
      const before = (await page.locator('.composer').boundingBox())!;
      const editorBefore = (await input.boundingBox())!;
      const toolbarBefore = (await page.locator('.composer-toolbar').boundingBox())!;
      await expectContainedComposer(page);
      await page.screenshot({ path: info.outputPath('empty-draft.png') });
      await input.fill('单行草稿');
      expect(await page.locator('.composer').boundingBox(), 'single-line draft does not shift the composer').toEqual(before);
      expect(await page.locator('.composer-toolbar').boundingBox(), 'single-line draft does not shift actions').toEqual(toolbarBefore);
      await expectContainedComposer(page);
      for (const target of [page.locator('.composer-add'), page.getByTestId('send-button'), page.getByTestId('model-thinking-trigger')]) {
        await expectUsableControl(target);
      }
      await expectNonOverlapping(page.locator('.composer-add'), page.getByTestId('send-button'));
      await expectNonOverlapping(page.getByTestId('model-thinking-trigger'), page.getByTestId('send-button'));
      await input.fill('多行\n'.repeat(LONG_DRAFT_LINE_COUNT));
      expect((await input.boundingBox())!.height).toBeGreaterThan(editorBefore.height);
      expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      await input.evaluate(el => { el.scrollTop = el.scrollHeight; });
      expect(await input.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await expectContainedComposer(page);
      await expectUsableControl(input);
      await expectUsableControl(page.getByTestId('send-button'));
      await info.attach('geometry', { body: JSON.stringify({ viewport, theme, state, before, after: await page.locator('.composer').boundingBox() }, null, 2), contentType: 'application/json' });
      expect(unexpected).toEqual([]);
    });
  }
}
