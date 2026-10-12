import { expect, type Locator } from '@playwright/test';

// Relative interior samples, not a minimum pixel-size contract.
export async function expectUsableControl(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  await target.click({ trial: true });
  expect(await target.evaluate(el => {
    const box = el.getBoundingClientRect();
    const samples = [0.25, 0.5, 0.75];
    return samples.every(y => samples.every(x =>
      el.contains(document.elementFromPoint(box.x + box.width * x, box.y + box.height * y))));
  })).toBe(true);
}

export async function expectNonOverlapping(a: Locator, b: Locator): Promise<void> {
  const first = (await a.boundingBox())!;
  const second = (await b.boundingBox())!;
  const overlapWidth = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const overlapHeight = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  expect(overlapWidth * overlapHeight).toBe(0);
}
