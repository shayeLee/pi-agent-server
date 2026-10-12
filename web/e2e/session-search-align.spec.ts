import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { workspaceFixture } from './workspace.fixture';
import { expectNonOverlapping, expectUsableControl } from './usable-control';

const evidence = '/tmp/pi-sidebar-v5-final';
for (const theme of ['light', 'dark'] as const) test(`v5 geometry, widths and project context ${theme}`, async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  async function assertFullBleed() {
    const boxes = await page.getByTestId('session-fixture-0').evaluate(el => {
      const row = el.parentElement!;
      const side = document.querySelector('.session-items')!.getBoundingClientRect();
      const b = row.getBoundingClientRect();
      const title = el.querySelector('.session-title')!.getBoundingClientRect();
      const time = el.querySelector('.session-time')!.getBoundingClientRect();
      const list = document.querySelector('.session-items')!;
      return { left: b.left - side.left, right: side.right - b.right, title: title.x - side.x,
        time: time.x - side.x, radius: getComputedStyle(row).borderRadius,
        hitWidth: el.getBoundingClientRect().width, width: b.width,
        overflow: list.scrollWidth > list.clientWidth, scrollable: list.scrollHeight > list.clientHeight };
    });
    expect(boxes.left).toBe(0);
    expect(boxes.right).toBe(0);
    expect(boxes.title).toBe(boxes.time);
    expect(boxes.title).toBeGreaterThan(boxes.left);
    expect(boxes.hitWidth).toBe(boxes.width);
    expect(boxes.overflow).toBe(false);
  }
  await expect(page.getByTestId('session-fixture-0')).toBeVisible();
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => {
      const b = document.querySelector(selector)!.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right };
    };
    return { sidebar: box('[data-testid="sidebar"]'), date: box('.session-date-group'), card: box('.session-item'),
      title: box('.session-title'), time: box('.session-time'),
      project: box('.workbench-project-select .select-menu-label'), logo: box('.brand-mark'), brand: box('.brand-text') };
  });
  const projectRowCenters = await page.evaluate(() => {
    const label = document.querySelector('.workbench-project-select .select-menu-label')!.getBoundingClientRect();
    const chevron = document.querySelector('.workbench-project-select .disclosure-chevron')!.getBoundingClientRect();
    const searchSvg = document.querySelector('.workbench-search-toggle svg')!.getBoundingClientRect();
    return {
      label: { y: label.y, h: label.height, cy: label.y + label.height / 2 },
      chevron: { y: chevron.y, h: chevron.height, cy: chevron.y + chevron.height / 2 },
      searchSvg: { y: searchSvg.y, h: searchSvg.height, cy: searchSvg.y + searchSvg.height / 2 },
    };
  });
  for (const icon of [projectRowCenters.chevron, projectRowCenters.searchSvg]) {
    expect(icon.cy).toBeGreaterThanOrEqual(projectRowCenters.label.y);
    expect(icon.cy).toBeLessThanOrEqual(projectRowCenters.label.y + projectRowCenters.label.h);
  }
  expect(geometry.title.x).toBe(geometry.time.x);
  expect(geometry.project.x).toBe(geometry.title.x);
  await assertFullBleed();
  expect(await page.locator('.session-date-group').first().evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    return range.getBoundingClientRect().x;
  })).toBe(geometry.title.x);
  expect(geometry.brand.x).toBeGreaterThanOrEqual(geometry.logo.right);
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/geometry-${theme}.json`, JSON.stringify(geometry, null, 2));

  await page.route('**/v1/projects', route => route.fulfill({ json: [{ id: 'fixture-project', name: '很长的项目名称'.repeat(20), cwd: '/fixture', isDefault: true }] }));
  await page.route(/\/v1\/sessions(?:\?.*)?$/, route => route.fulfill({ json: Array.from({ length: 35 }, (_, i) => ({
    id: `fixture-${i}`, projectId: 'fixture-project', title: '安全长会话 ABC .*[] <img src=x> 中文搜索'.repeat(8),
    createdAt: 1, updatedAt: Date.now() - i * 86400000, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null,
  })) }));
  await page.reload();
  await expect(page.locator('.session-item')).toHaveCount(35);
  expect(await page.locator('.session-items').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByTestId('session-fixture-0').click({ position: { x: 2, y: 2 } });
  await expect(page.getByTestId('session-fixture-0')).toHaveAttribute('aria-current', 'true');
  for (const width of [400, 180, 280]) {
    const sidebar = page.getByTestId('sidebar');
    const current = (await sidebar.boundingBox())!.width;
    const handle = (await page.locator('.resize-handle.sidebar').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
    await page.mouse.down();
    await expect(page.getByTestId('app')).toHaveClass(/dragging/);
    await page.mouse.move(handle.x + handle.width / 2 + width - current, handle.y + 100);
    await page.mouse.up();
    await expect(page.getByTestId('app')).not.toHaveClass(/dragging/);
    // Preserve existing narrow-drag rail behavior; reopening restores the chosen width.
    if (await page.getByTestId('app').evaluate(el => el.classList.contains('sidebar-collapsed'))) await page.getByTestId('toggle-sidebar').click();
    const resizedWidth = (await sidebar.boundingBox())!.width;
    if (width > current) expect(resizedWidth).toBeGreaterThan(current);
    else if (width < current) expect(resizedWidth).toBeLessThan(current);
    expect(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.session-items').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.session-title').first().evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    const search = page.getByRole('button', { name: '搜索会话', exact: true });
    const project = page.getByTestId('project-select');
    const searchBox = (await search.boundingBox())!;
    const projectBox = (await project.boundingBox())!;
    expect(projectBox.x + projectBox.width).toBeLessThanOrEqual(searchBox.x);
    const projectRowBox = (await page.locator('.workbench-project-row').boundingBox())!;
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(projectRowBox.x + projectRowBox.width);
    await expectUsableControl(search);
    await expectNonOverlapping(project, search);
    await search.click();
    expect(await project.boundingBox()).toEqual(projectBox);
    expect(await search.boundingBox()).toEqual(searchBox);
    const input = page.getByTestId('session-search');
    for (const query of ['abc', '.*[]', '<img src=x>', '中文搜索']) {
      await input.fill(query);
      await expect(page.locator('.session-item')).toHaveCount(35);
      await expect(page.locator('.session-title mark').first()).toHaveText(query === 'abc' ? 'ABC' : query);
      await expect(page.locator('.session-title img')).toHaveCount(0);
    }
    await page.getByTestId('session-fixture-0').hover({ position: { x: 2, y: 2 } });
    await assertFullBleed();
    await expect(page.getByTestId('session-fixture-0').locator('..')).toHaveClass(/active/);
    await page.getByTestId('session-fixture-1').hover({ position: { x: 2, y: 2 } });
    await page.screenshot({ path: `${evidence}/width-${width}-${theme}.png` });
    await search.click();
    await expect(search).toBeFocused();
    await search.click();
    await expect(input).toHaveValue('');
    await input.press('Escape');
  }
  const expandedWidth = (await page.getByTestId('sidebar').boundingBox())!.width;
  await page.getByTestId('toggle-sidebar').click();
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBeLessThan(expandedWidth);
  await page.screenshot({ path: `${evidence}/rail-${theme}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开工作区导航' }).click();
  const mobileCenters = await page.evaluate(() => {
    const label = document.querySelector('.workbench-project-select .select-menu-label')!.getBoundingClientRect();
    const chevron = document.querySelector('.workbench-project-select .disclosure-chevron')!.getBoundingClientRect();
    const searchSvg = document.querySelector('.workbench-search-toggle svg')!.getBoundingClientRect();
    return {
      label: { y: label.y, h: label.height, cy: label.y + label.height / 2 },
      chevron: { y: chevron.y, h: chevron.height, cy: chevron.y + chevron.height / 2 },
      searchSvg: { y: searchSvg.y, h: searchSvg.height, cy: searchSvg.y + searchSvg.height / 2 },
    };
  });
  for (const icon of [mobileCenters.chevron, mobileCenters.searchSvg]) {
    expect(icon.cy).toBeGreaterThanOrEqual(mobileCenters.label.y);
    expect(icon.cy).toBeLessThanOrEqual(mobileCenters.label.y + mobileCenters.label.h);
  }
  for (const target of [page.getByTestId('project-select'), page.getByRole('button', { name: '搜索会话', exact: true })]) await expectUsableControl(target);
  await expectNonOverlapping(page.getByTestId('project-select'), page.getByRole('button', { name: '搜索会话', exact: true }));
  await page.getByTestId('project-select').click();
  await expectUsableControl(page.getByTestId('new-project'));
  await page.keyboard.press('Escape');
  await assertFullBleed();
  await page.screenshot({ path: `${evidence}/fullbleed-mobile-${theme}.png` });
  const listBox = (await page.locator('.session-items').boundingBox())!;
  await page.mouse.move(listBox.x + listBox.width - 3, listBox.y + 100);
  await page.mouse.wheel(0, 5000);
  await expect(page.getByTestId('session-fixture-34')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(unexpected).toEqual([]);
});

test('empty and loading projects keep context and never expose previous results', async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  await page.route('**/v1/projects', route => route.fulfill({ json: [
    { id: 'fixture-project', name: '有会话', cwd: '/fixture', isDefault: true },
    { id: 'empty-a', name: '空项目 A', cwd: '/a', isDefault: false },
    { id: 'empty-b', name: '空项目 B', cwd: '/b', isDefault: false },
  ] }));
  let release: (() => void) | undefined;
  await page.route(/\/v1\/sessions(?:\?.*)?$/, async route => {
    if (new URL(route.request().url()).searchParams.get('projectId')?.startsWith('empty-')) {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: [] });
    } else await route.fallback();
  });
  await page.goto('/');
  for (const name of ['空项目 A', '空项目 B']) {
    await page.getByRole('button', { name: '搜索会话', exact: true }).click();
    await page.getByTestId('session-search').fill('旧查询');
    await page.getByTestId('project-select').click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
    await expect(page.getByTestId('project-select')).toContainText(name);
    await expect(page.getByTestId('sessions-loading')).toBeVisible();
    await expect(page.getByTestId('session-search')).toBeHidden();
    await expect(page.locator('.session-item')).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/${name}-loading.png` });
    await expect.poll(() => !!release).toBe(true);
    release!(); release = undefined;
    await expect(page.getByTestId('empty-sessions')).toHaveText('暂无会话');
    await page.screenshot({ path: `${evidence}/${name}-empty.png` });
  }
  expect(unexpected).toEqual([]);
});
