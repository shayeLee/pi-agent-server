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
        const line = getComputedStyle(el, '::before');
        return { leftPadding: text.left - box.left, rightPadding: box.right - text.right,
          width: box.width, height: box.height, font: getComputedStyle(number).fontSize,
          icon: el.querySelector('.step-icon')!.getBoundingClientRect().left,
          main: el.querySelector('.step-main')!.getBoundingClientRect().left,
          center: box.left + box.width / 2,
          line: el.getBoundingClientRect().left + parseFloat(line.left) + .5 };
      }));
      for (const [i, row] of rows.entries()) {
        expect(row.font).toBe('10px');
        expect(row.leftPadding).toBeGreaterThanOrEqual(4.9);
        expect(row.rightPadding).toBeGreaterThanOrEqual(4.9);
        expect(row.height).toBe(22);
        expect(row.icon).toBe(rows[0].icon);
        expect(row.main).toBe(rows[0].main);
        expect(Math.abs(row.center - rows[0].center)).toBeLessThan(.1);
        if (i < rows.length - 1) expect(Math.abs(row.line - row.center)).toBeLessThan(.1);
      }
      expect(rows[0].width).toBe(22);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/pi-header-nav-refine/numbers/${width}-${theme}-${max}.png` });
    }
  });
}
