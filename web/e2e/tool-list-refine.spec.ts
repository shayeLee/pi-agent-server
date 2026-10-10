import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
for (const width of [1280, 390]) for (const theme of ["dark", "light"]) test(`${theme} ${width} complete names and Inspector`, async ({page}) => {
 await mkdir('/tmp/tool-list-refine', {recursive: true});
 await page.setViewportSize({width, height: 844});
 await page.goto(`/visual-fixtures/tool-list-refine.html?theme=${theme}`);
 const names = page.locator('.tool-name');
 for (const name of await names.all()) {
  expect(await name.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(name).not.toHaveCSS('text-overflow', 'ellipsis');
 }
 for (const header of await page.locator('.tool-call-header').all()) {
  expect(await header.evaluate(el => {
   const right = el.getBoundingClientRect().right;
   return [...el.querySelectorAll('.tool-status-icon, .tool-toggle')].every(icon => icon.getBoundingClientRect().right <= right);
  })).toBe(true);
 }
 const longHeader = page.locator('[data-tool-call-id="long"] .tool-call-header');
 await longHeader.click();
 await expect(longHeader).toHaveAttribute('aria-expanded', 'true');
 await longHeader.click();
 await expect(longHeader).toHaveAttribute('aria-expanded', 'false');
 await page.mouse.move(0, 0);
 await expect(names.first()).toHaveText('subagent_wait');
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.screenshot({path: `/tmp/tool-list-refine/${theme}-${width}-main.png`});
 await page.getByRole('button', {name: '打开 Inspector'}).click();
 await page.getByTestId('inspector-tab-tools').click();
 const row = page.locator('.tool-summary').first();
 await expect(row.locator('.tool-summary-description')).toContainText('runIds=[1]');
 await expect(row.getByRole('img', {name: '已完成'})).toHaveCount(1);
 await page.mouse.move(0, 0);
 await expect(row.locator('.tool-status-icon')).toHaveCSS('opacity', '0');
 await row.hover();
 await expect(row.locator('.tool-status-icon')).toHaveCSS('opacity', '1');
 await page.mouse.move(0, 0);
 await row.focus();
 await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
 await expect(row.locator('.tool-status-icon')).toHaveCSS('opacity', '1');
 await expect(page.locator('.tool-summary.running .tool-status-icon')).toHaveCSS('opacity', '1');
 await page.getByTestId('inspector-tab-tools').click(); await page.mouse.move(0, 0);
 await page.screenshot({path: `/tmp/tool-list-refine/${theme}-${width}-inspector.png`});
 expect(await page.locator('.inspector').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
 await page.getByTestId('inspector-close').click();
 await expect(page.getByTestId('inspector')).toHaveCount(0);
});
test('touch keeps statuses visible', async ({browser}) => {
 const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true});
 const page = await context.newPage();
 await page.goto('/visual-fixtures/tool-list-refine.html');
 await page.getByRole('button', {name: '打开 Inspector'}).click();
 await page.getByTestId('inspector-tab-tools').click();
 await expect(page.locator('.tool-summary.done .tool-status-icon').first()).toHaveCSS('opacity', '1');
 await context.close();
});
