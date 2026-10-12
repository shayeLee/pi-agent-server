import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const out = '/tmp/tool-duration-pi110';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [];
try {
 for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:5199' ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:5199/visual-fixtures/tool-duration.html?theme=${theme}`);
  await page.locator('.tool-call').first().waitFor();
  const live = page.locator('[data-tool-call-id="live"]');
  await live.locator('.tool-call-header').click();
  await live.locator('.tool-call-header').click();
  assert.equal(await live.locator('.tool-call-body > :not(section)').count(), 0);
  await page.screenshot({ path: `${out}/${theme}-${width}-streaming.png`, fullPage: true });
  await page.getByRole('button', { name: '完成 fixture 调用' }).click();
  assert.equal(await live.locator('.tool-call-header').getAttribute('aria-expanded'), 'true');
  assert.equal(await live.locator('.tool-duration').innerText(), '2.3 s');
  for (const header of await page.locator('.tool-call-header').all()) if (await header.getAttribute('aria-expanded') === 'true') await header.click();
  await page.screenshot({ path: `${out}/${theme}-${width}-collapsed.png`, fullPage: true });
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, cards: [...document.querySelectorAll('.tool-call')].map(card => {
    const name = card.querySelector('.tool-name'); const icons = card.querySelector('.tool-header-icons');
    return { nameClipped: name.scrollWidth > name.clientWidth + 1, iconsClipped: icons.getBoundingClientRect().right > card.getBoundingClientRect().right, hidden: [...card.querySelectorAll('.tool-status-icon,.tool-toggle')].some(el => getComputedStyle(el).opacity === '0') };
  }) }));
  assert.equal(layout.overflow, false);
  assert.ok(layout.cards.every(c => !c.nameClipped && !c.iconsClipped && !c.hidden), JSON.stringify(layout));
  assert.equal(await page.locator('[data-tool-call-id="old"] .tool-duration').count(), 0);
  assert.equal(await page.locator('[data-tool-call-id="null"] .tool-duration').count(), 0);
  assert.equal(await page.locator('[data-tool-call-id="zero"] .tool-duration').innerText(), '0 ms');
  for (const header of await page.locator('.tool-call-header').all()) await header.click();
  await page.screenshot({ path: `${out}/${theme}-${width}-expanded.png`, fullPage: true });
  assert.equal(await page.getByRole('region', { name: '结果', exact: true }).count(), 9);
  assert.deepEqual(errors, []);
  results.push({ theme, width, layout, errors });
  await context.close();
 }
 await writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
