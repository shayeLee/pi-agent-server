import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`number gutters ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mkdir('/tmp/pi-header-nav-refine/numbers', { recursive: true });
    for (const max of [1, 99, 999, 1000, 1447, 99999]) {
      await page.goto(`/visual-fixtures/steps.html?theme=${theme}&numberMax=${max}`);
      await expect(page.locator('.step-number').last()).toHaveText(String(max));
      await expect(page.getByTestId('session-steps')).not.toHaveAttribute('title');
      await expect(page.getByTestId('inspector-tab-steps')).toHaveAttribute('title', /历史按已保存记录顺序/);
      const rows = await page.locator('.session-step').evaluateAll(els => els.map(el => {
        const number = el.querySelector('.step-number')!;
        const box = number.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(number);
        const text = range.getBoundingClientRect();
        return { leftPadding: text.left - box.left, rightPadding: box.right - text.right,
          height: box.height, right: box.right,
          main: el.querySelector('.step-main')!.getBoundingClientRect().left };
      }));
      for (const row of rows) {
        // The number always fits its gutter, however many digits; numbers right-align and content starts on one line.
        expect(row.leftPadding).toBeGreaterThanOrEqual(0);
        expect(row.rightPadding).toBeGreaterThanOrEqual(0);
        expect(row.height).toBe(rows[0].height);
        expect(Math.abs(row.right - rows[0].right)).toBeLessThan(.1);
        expect(row.main).toBe(rows[0].main);
        expect(row.right).toBeLessThanOrEqual(row.main);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/pi-header-nav-refine/numbers/${width}-${theme}-${max}.png` });
    }
  });
}
