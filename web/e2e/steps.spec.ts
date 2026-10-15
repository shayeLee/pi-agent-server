import { test, expect } from '@playwright/test';
for (const width of [1440,1280,390]) for (const theme of ['light','dark']) {
 test(`${width} ${theme} steps sidebar and keyboard`, async ({page}, info) => {
  await page.setViewportSize({width,height:900});
  await page.route('**/v1/**',route=>route.abort());
  await page.goto(`/visual-fixtures/steps.html?theme=${theme}`);
  const panel = page.getByTestId('inspector');
  await expect(page.getByRole('tab',{name:'步骤 7'})).toHaveAttribute('aria-selected','true');
  // Narrow screens give the Inspector the full width; wider ones keep it a side column.
  const panelWidth = (await panel.boundingBox())!.width;
  if (width <= 600) expect(panelWidth).toBe(width); else expect(panelWidth).toBeLessThan(width / 2);
  await page.screenshot({path:info.outputPath(`steps-${width}-${theme}.png`)});
  // Without a matching transcript row, activating a long result opens its full details.
  await page.getByRole('button',{name:/工具结果.*subagent/}).click();
  const details = page.getByRole('dialog');
  await expect(details).toBeVisible();
  await expect(details.getByText(/END_OF_RESULT/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
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
