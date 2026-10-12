import { test, expect } from '@playwright/test';
for (const width of [1440,1280,390]) for (const theme of ['light','dark']) {
 test(`${width} ${theme} steps sidebar and keyboard`, async ({page}, info) => {
  await page.setViewportSize({width,height:900});
  await page.route('**/v1/**',route=>route.abort());
  await page.goto(`/visual-fixtures/steps.html?theme=${theme}`);
  const panel = page.getByTestId('inspector');
  await expect(page.getByRole('tab',{name:'步骤 7'})).toHaveAttribute('aria-selected','true');
  expect((await panel.boundingBox())?.width).toBe(width <= 600 ? width : 380);
  await expect(panel.locator('.step-heading').first()).toHaveCSS('font-size', '12px');
  await expect(panel.locator('.step-tool-name').first()).toHaveCSS('font-size', '12px');
  await expect(panel.locator('.step-content pre').first()).toHaveCSS('font-size', '11px');
  await expect(panel.locator('.step-toggle time').first()).toHaveCSS('font-size', '10px');
  await expect(panel.locator('.inspector-tabs button').first()).toHaveCSS('font-size', '12px');
  await expect(panel.locator('.tab-badge').first()).toHaveCSS('font-size', '10px');
  await page.getByRole('button',{name:/工具调用.*subagent/}).click();
  await page.screenshot({path:info.outputPath(`steps-${width}-${theme}.png`)});
  const result = page.getByRole('button',{name:/工具结果.*subagent/});
  await result.click();
  await expect(result).toHaveAttribute('aria-expanded','true');
  await expect(page.getByText(/END_OF_RESULT/)).toBeVisible();
  await page.getByRole('tab',{name:'步骤 7'}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('创建时快照 · 不是实时运行值')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:'事件流'})).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
 });
}
