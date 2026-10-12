import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { workspaceFixture } from './workspace.fixture';
import { appearance } from './focus-appearance';

for (const theme of ['light', 'dark'] as const) test(`project trigger neutral compact hover ${theme}`, async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  let name = 'pi';
  await page.route('**/v1/projects', route => route.fulfill({ json: [
    { id: 'fixture-project', name, cwd: '/fixture', isDefault: true },
  ] }));
  for (const title of ['pi', 'pi-agent-server', '很长的项目名称'.repeat(30)]) {
    name = title;
    await page.goto('/');
    const trigger = page.getByTestId('project-select');
    await expect(trigger).toContainText(title);
    for (const width of [180, 280, 400, 390]) {
      const mobile = width === 390;
      await page.setViewportSize({ width: mobile ? 390 : 1440, height: mobile ? 844 : 900 });
      if (mobile) await page.getByRole('button', { name: '打开工作区导航' }).click();
      else {
        const sidebar = page.getByTestId('sidebar');
        const current = (await sidebar.boundingBox())!.width;
        const handle = (await page.locator('.resize-handle.sidebar').boundingBox())!;
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 + width - current, handle.y + 100);
        await page.mouse.up();
        if ((await sidebar.boundingBox())!.width === 56) await page.getByTestId('toggle-sidebar').click();
        expect((await sidebar.boundingBox())!.width).toBe(width);
      }
      const search = page.getByRole('button', { name: '搜索会话', exact: true });
      const searchBox = await search.boundingBox();
      await page.mouse.move(700, 800);
      await trigger.evaluate(el => (el as HTMLElement).blur());
      const resting = await appearance(trigger);
      const neutral = async () => {
        await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(trigger).toHaveCSS('box-shadow', 'none');
        await expect(trigger).toHaveCSS('border-top-width', '0px');
        await expect(trigger).toHaveCSS('outline-style', 'none');
        expect(await search.boundingBox()).toEqual(searchBox);
      };
      await neutral();
      await trigger.hover();
      await neutral();
      const geometry = await trigger.evaluate(el => {
        const label = el.querySelector('.select-menu-label')!;
        const arrow = el.querySelector('.disclosure-chevron')!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        const box = label.getBoundingClientRect();
        const side = document.querySelector('[data-testid="sidebar"]')!;
        return { gap: arrow.left - Math.min(text.right, box.right), clipped: label.scrollWidth > label.clientWidth,
          arrowWidth: arrow.width, right: arrow.right, triggerRight: el.getBoundingClientRect().right,
          overflow: side.scrollWidth > side.clientWidth, nameX: box.x - side.getBoundingClientRect().x };
      });
      expect(geometry.gap).toBeGreaterThanOrEqual(3.5);
      expect(geometry.gap).toBeLessThanOrEqual(8.1); // fractional font advance, not the full trigger span
      expect(geometry.nameX).toBe(16);
      expect(geometry.arrowWidth).toBe(12);
      expect(geometry.right).toBeLessThanOrEqual(geometry.triggerRight);
      expect(geometry.triggerRight).toBeLessThanOrEqual(searchBox.x);
      expect(geometry.overflow).toBe(false);
      if (title.length > 100) expect(geometry.clipped).toBe(true);
      if (mobile) for (const control of [trigger, search]) {
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: `/tmp/pi-project-row-polish/${theme}-${width}-${title.length > 100 ? 'long' : title}-hover.png` });
      // The spare space remains part of the same button, not a second arrow action.
      const box = (await trigger.boundingBox())!;
      await trigger.click({ position: { x: box.width - 2, y: box.height / 2 } });
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await neutral();
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.mouse.move(700, 800);
      for (const key of ['Enter', 'Space']) {
        await trigger.focus();
        expect(await appearance(trigger)).toEqual(resting);
        await trigger.press(key);
        await expect(page.getByRole('menu', { name: '选择项目' })).toBeFocused();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await neutral();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await neutral();
      }
      if (mobile) await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(unexpected).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) for (const long of [false, true]) {
  test(`aligned inspector headers ${theme} ${long ? 'wrapped' : 'short'}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const unexpected = await workspaceFixture(page);
    const title = long ? '长会话标题保持完整换行与十八像素字号，检查两栏题头底线及标签垂直中心。'.repeat(4) : '短标题';
    await page.route(/\/v1\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [{ id: 'fixture-0', projectId: 'fixture-project', title, createdAt: 1, updatedAt: 1, modelProvider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'off', systemPrompt: null }] }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('session-fixture-0').click();
    await page.getByTestId('trace-tab').click();
    const aligned = async () => {
      await expect.poll(() => page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const chat = box('[data-testid="chat-header"]');
        const tabs = box('.inspector-tabs');
        const trace = box('[data-testid="trace-tab"]');
        const step = box('[data-testid="inspector-tab-steps"]');
        const close = box('[data-testid="inspector-close"]');
        const center = (b: DOMRect) => b.y + b.height / 2;
        return Math.max(Math.abs(chat.bottom - tabs.bottom), Math.abs(center(trace) - center(step)), Math.abs(center(close) - center(step)));
      })).toBeLessThanOrEqual(1);
      await expect(page.locator('.session-title-main')).toHaveCSS('font-size', '18px');
      expect((await page.getByTestId('inspector').boundingBox())!.width).toBe(380);
      const titleBox = await page.locator('.session-title-main').evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), clipped: el.scrollHeight > el.clientHeight }));
      if (long) expect(titleBox.height).toBeGreaterThan(titleBox.line);
      expect(titleBox.clipped).toBe(false);
    };
    for (const width of [1440, 1280, 1100, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await aligned();
      await page.screenshot({ path: info.outputPath(`${width}.png`) });
      await page.getByTestId('inspector-close').click();
      await expect(page.getByTestId('inspector')).toHaveCount(0);
      expect(await page.getByTestId('app').evaluate(el => (el as HTMLElement).style.getPropertyValue('--inspector-header-height'))).toBe('');
      await page.getByTestId('trace-tab').click();
      await aligned();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('chat-header')).toBeHidden();
    const close = page.getByTestId('inspector-close');
    const b = (await close.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: info.outputPath('mobile.png') });
    await close.click();
    await expect(page.getByTestId('chat-header')).toBeVisible();
    await page.getByTestId('trace-tab').click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await aligned();
    expect(unexpected).toEqual([]);
  });
}

for (const theme of ['light', 'dark'] as const) test(`sidebar reference evidence ${theme}`, async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('session-fixture-0').click();
  await page.getByTestId('trace-tab').click();
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(280);
    expect((await page.getByTestId('inspector').boundingBox())!.width).toBe(380);
    await page.mouse.move(700, 800);
    await page.screenshot({ path: `/tmp/pi-sidebar-reference-final/${width}-${theme}.png` });
  }
  await page.getByTestId('toggle-sidebar').click();
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(56);
  await page.screenshot({ path: `/tmp/pi-sidebar-reference-final/rail-${theme}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('inspector-close').click();
  await page.getByRole('button', { name: '打开工作区导航' }).click();
  await expect(page.locator('.workbench-project-row')).toBeVisible();
  await page.screenshot({ path: `/tmp/pi-sidebar-reference-final/390-${theme}.png` });
  for (const id of ['session-fixture-0', 'rename-fixture-0', 'export-fixture-0', 'delete-fixture-0']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  const projectBox = (await page.getByTestId('project-select').boundingBox())!;
  expect(projectBox.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  await page.getByTestId('session-search').fill('不存在的隔离标题');
  await expect(page.getByTestId('empty-sessions')).toBeVisible();
  await page.screenshot({ path: `/tmp/pi-sidebar-reference-final/search-empty-${theme}.png` });
  await page.getByTestId('session-search').fill('附件');
  await page.screenshot({ path: `/tmp/pi-sidebar-reference-final/search-${theme}.png` });
  await page.getByTestId('session-time-fixture-2').click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(page.getByTestId('chat-header')).toContainText('附件状态');
  expect(unexpected).toEqual([]);
});

test('session whole-row hit boundaries, keyboard and independent actions', async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  let deletes = 0;
  await page.route('**/v1/sessions/fixture-1', async route => {
    if (route.request().method() === 'DELETE') { deletes++; await route.fulfill({ status: 204 }); }
    else await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const original = history.pushState.bind(history);
    (window as any).navigations = [];
    history.pushState = (...args) => { (window as any).navigations.push(String(args[2])); original(...args); };
  });
  await page.goto('/');
  const count = () => page.evaluate(() => (window as any).navigations.length as number);
  const reset = () => page.evaluate(() => { (window as any).navigations = []; });
  for (const hit of ['padding', 'right-edge', 'time', 'title', 'Enter', 'Space']) {
    await page.getByTestId('session-fixture-1').click();
    await expect(page.getByTestId('session-fixture-1')).toHaveAttribute('aria-current', 'true');
    await reset();
    const select = page.getByTestId('session-fixture-0');
    if (hit === 'padding') {
      const row = (await select.locator('..').boundingBox())!;
      await page.mouse.click(row.x + 2, row.y + row.height - 2);
    } else if (hit === 'right-edge') {
      const row = (await select.boundingBox())!;
      await page.mouse.click(row.x + row.width - 2, row.y + 2);
    } else if (hit === 'time') await page.getByTestId('session-time-fixture-0').click();
    else if (hit === 'title') await select.locator('.session-title').click();
    else { await select.focus(); await page.keyboard.press(hit); }
    await expect(select).toHaveAttribute('aria-current', 'true');
    expect(await count()).toBe(1);
  }
  await reset();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByTestId('rename-fixture-1').click();
  expect(await count()).toBe(0);
  const download = page.waitForEvent('download');
  await page.getByTestId('export-fixture-1').click();
  await download;
  await page.getByTestId('delete-fixture-1').click();
  await expect(page.getByTestId('session-fixture-1')).toHaveCount(0);
  expect(deletes).toBe(1);
  expect(await count()).toBe(0);
  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  await page.getByTestId('project-select').click();
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('project-create-form')).toBeVisible();
  await page.getByTestId('project-create-cancel').click();
  await page.getByTestId('project-select').click();
  await expect(page.getByRole('menu', { name: '选择项目' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await count()).toBe(0);
  await expect(page.getByTestId('session-fixture-0')).toHaveAttribute('aria-current', 'true');
  const longTitle = '隔离长标题用于验证省略且完整可访问。'.repeat(16);
  await page.route(/\/v1\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [{ id: 'fixture-0', projectId: 'fixture-project', title: longTitle, createdAt: 1, updatedAt: Date.now(), modelProvider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'off', systemPrompt: null }] }));
  await page.reload();
  await expect(page.getByTestId('session-fixture-0')).toHaveAccessibleName(longTitle);
  await expect(page.locator('.session-title')).toHaveAttribute('title', longTitle);
  expect(await page.locator('.session-title').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/pi-sidebar-reference-final/long-title.png' });
  expect(unexpected).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) test(`continuous sidebar search ${theme}`, async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('session-fixture-0').click();
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    if (width === 390) await page.getByRole('button', { name: '打开工作区导航' }).click();
    const list = page.locator('.session-items');
    const top = (await list.boundingBox())!.y;
    const project = (await page.locator('.workbench-project-row').boundingBox())!;
    expect(top - project.y - project.height).toBe(8);
    await page.mouse.move(700, 800);
    await page.screenshot({ path: `/tmp/pi-sidebar-v5-final/${width}-${theme}-closed.png` });
    if (width === 1440) {
      await page.getByTestId('session-fixture-1').hover();
      await page.screenshot({ path: `/tmp/pi-sidebar-v5-final/hover-${theme}.png` });
      await page.mouse.move(700, 800);
    }
    const toggle = page.getByRole('button', { name: '搜索会话', exact: true });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const input = page.getByTestId('session-search');
    await expect(input).toBeFocused();
    const focusedAppearance = await appearance(input);
    await input.evaluate(el => (el as HTMLElement).blur());
    expect(await appearance(input)).toEqual(focusedAppearance);
    await input.focus();
    await expect(page.getByRole('button', { name: '清空搜索' })).toHaveCount(0);
    await input.press('Tab');
    await expect(page.getByTestId('session-fixture-0')).toBeFocused();
    await input.focus();
    const expandedTop = top + (width === 390 ? 56 : 42);
    expect((await list.boundingBox())!.y).toBe(expandedTop);
    expect(await page.locator('.workbench-project-row').boundingBox()).toEqual(project);
    await page.screenshot({ path: `/tmp/pi-sidebar-v5-final/${width}-${theme}-search-empty.png` });
    await input.fill('附件');
    const clear = page.getByRole('button', { name: '清空搜索' });
    await expect(clear).toHaveAttribute('title', '清空搜索');
    if (width === 390) {
      const box = (await clear.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId('session-fixture-2')).toBeVisible();
    await expect(page.getByTestId('session-fixture-0')).toHaveCount(0);
    expect((await list.boundingBox())!.y).toBe(expandedTop);
    await expect(page.locator('.session-title mark')).toHaveText('附件');
    await page.screenshot({ path: `/tmp/pi-sidebar-v5-final/${width}-${theme}-search-query.png` });
    await input.dispatchEvent('compositionstart');
    await input.press('Escape');
    await expect(input).toHaveValue('附件');
    await expect(input).toBeFocused();
    await input.dispatchEvent('compositionend');
    await input.press('Tab');
    await expect(clear).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await expect(input).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(clear).toHaveCount(0);
    await expect(page.locator('.session-select')).toHaveCount(4);
    expect((await list.boundingBox())!.y).toBe(expandedTop);
    await page.screenshot({ path: `/tmp/pi-sidebar-search-clear/${width}-${theme}-cleared.png` });
    await input.fill('附件');
    await input.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    expect((await list.boundingBox())!.y).toBe(top);
    await toggle.click();
    await expect(input).toHaveValue('');
    await input.fill('不存在的标题');
    await expect(page.getByTestId('empty-sessions')).toBeVisible();
    await expect(page.getByTestId('empty-sessions')).toContainText('未找到相关会话');
    const emptyBox = (await page.getByTestId('empty-sessions').boundingBox())!;
    const emptyIcon = (await page.getByTestId('empty-sessions').locator('svg').boundingBox())!;
    expect(Math.abs(emptyBox.x + emptyBox.width / 2 - emptyIcon.x - emptyIcon.width / 2)).toBeLessThanOrEqual(1);
    await page.mouse.move(width - 10, 800);
    await page.screenshot({ path: `/tmp/pi-sidebar-v5-final/${width}-${theme}-no-results.png` });
    await page.getByTestId('empty-sessions').getByRole('button', { name: '清空搜索' }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('session-fixture-0')).toBeVisible();
    await expect(input).toBeVisible();
    await expect(clear).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId('session-fixture-0')).toHaveAttribute('aria-current', 'true');
  }
  await page.getByTestId('session-time-fixture-0').click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('session-search')).toBeHidden();
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByRole('button', { name: '搜索会话', exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test('project switch resets local search without exposing previous project results', async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  await page.route('**/v1/projects', route => route.fulfill({ json: [
    { id: 'fixture-project', name: '隔离 UI 项目', cwd: '/fixture', isDefault: true },
    { id: 'second-project', name: '第二项目', cwd: '/fixture-second', isDefault: false },
  ] }));
  await page.route(/\/v1\/sessions(?:\?.*)?$/, async route => {
    if (new URL(route.request().url()).searchParams.get('projectId') === 'second-project') {
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ json: [{ id: 'second-session', projectId: 'second-project', title: '新项目会话', createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null }] });
    } else await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  await page.getByTestId('session-search').fill('附件');
  await page.getByTestId('project-select').click();
  await page.getByRole('menuitemradio', { name: '第二项目' }).click();
  await expect(page.getByTestId('session-fixture-2')).toHaveCount(0);
  await expect(page.getByTestId('session-second-session')).toBeVisible();
  await expect(page.getByRole('button', { name: '搜索会话', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  await expect(page.getByTestId('session-search')).toHaveValue('');
  expect(unexpected).toEqual([]);
});

test('project menu semantics, keyboard selection and create cancellation', async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  await page.route('**/v1/projects', route => route.fulfill({ json: [
    { id: 'fixture-project', name: '隔离 UI 项目', cwd: '/fixture', isDefault: true },
    { id: 'second-project', name: '第二项目', cwd: '/fixture-second', isDefault: false },
  ] }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const trigger = page.getByTestId('project-select');
  const search = page.getByRole('button', { name: '搜索会话', exact: true });
  const triggerBox = await trigger.boundingBox();
  const searchBox = await search.boundingBox();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await trigger.focus();
  const resting = await appearance(trigger);
  await trigger.press('ArrowDown');
  const menu = page.getByRole('menu', { name: '选择项目' });
  await expect(menu).toBeFocused();
  await expect(menu.getByRole('menuitemradio', { name: '隔离 UI 项目' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: '第二项目' })).toHaveAttribute('aria-checked', 'false');
  await expect(menu.getByRole('menuitem', { name: '新建项目' })).not.toHaveAttribute('aria-selected');
  expect(await trigger.boundingBox()).toEqual(triggerBox);
  expect(await search.boundingBox()).toEqual(searchBox);
  expect(await appearance(trigger)).toEqual(resting);
  await page.keyboard.press('Space');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const second = menu.getByRole('menuitemradio', { name: '第二项目' });
  await expect(menu).toHaveAttribute('aria-activedescendant', (await second.getAttribute('id'))!);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toContainText('第二项目');
  // Cross-project selection remounts SessionList and its trigger (existing App behavior).
  await trigger.press('End');
  await expect(menu).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('project-name-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-create-form')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await search.click();
  await expect(menu).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

async function chooseTheme(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('theme-toggle').click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}

test('isolated two-column workspace, disclosures, menus, drafts and responsive themes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const unexpected = await workspaceFixture(page);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/');
  await page.getByTestId('session-fixture-0').click();
  await expect(page.getByTestId('tool-call-card')).toHaveCount(4);
  await page.locator('.tool-call-header').first().click();
  await page.locator('.tool-call-header').nth(2).click();
  await expect(page.locator('.tool-call-body')).toHaveCount(2);
  const composerInput = page.getByTestId('composer-input');
  await composerInput.focus();
  const restingTextareaBackground = await composerInput.evaluate(el => {
    (el as HTMLElement).blur();
    return getComputedStyle(el).backgroundColor;
  });
  await composerInput.focus();
  await expect(composerInput).toBeFocused();
  expect(await composerInput.evaluate(el => el.matches(':focus-visible'))).toBe(true);
  await expect(composerInput).toHaveCSS('background-color', restingTextareaBackground);
  await expect(composerInput).toHaveCSS('outline-style', 'none');
  await page.screenshot({ path: 'test-results/workspace/desktop-light.png' });
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(280);
  await expect(page.getByTestId('tool-name')).toHaveText(['read', 'grep', 'bash', 'edit']);
  await expect(page.locator('.tool-call-heading [data-icon="ellipsis"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看原始数据', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制原始数据', exact: true })).toHaveCount(0);
  await expect(page.locator('.tool-call-body > :not(section)')).toHaveCount(0);
  await expect(page.getByTestId('tool-call-card').first()).toContainText('/fixture/draft.ts');
  await page.getByTestId('tool-call-card').nth(2).screenshot({ path: 'test-results/workspace/tool-expanded-no-footer.png' });
  await page.getByTestId('composer-input').fill('未发送草稿\n第二行');
  await page.getByTestId('composer-input').press('Shift+Enter');
  await expect(page.getByTestId('composer-input')).toHaveValue('未发送草稿\n第二行\n');
  await page.getByTestId('composer-file-input').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGJkAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByTestId('composer-attachment')).toContainText('就绪');
  await page.getByRole('button', { name: '移除附件 fixture.png' }).click();
  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  await page.getByTestId('session-search').fill('附件状态');
  await expect(page.getByTestId('session-fixture-2')).toBeVisible();
  await expect(page.getByTestId('session-fixture-0')).toHaveCount(0);
  await page.getByTestId('session-search').fill('');
  for (const width of [1536, 1000, 390]) {
    await page.setViewportSize({ width, height: width === 1536 ? 1024 : 844 });
    if (width < 1180) {
      await page.getByRole('button', { name: '打开工作区导航' }).click();
      await expect(page.getByTestId('sidebar')).toBeVisible();
    }
    await chooseTheme(page, '深色');
    if (width < 1180) {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('sidebar')).toBeHidden();
    }
    await expect(page.getByTestId('composer-input')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/workspace/${width}-dark.png` });
  }
  await page.getByRole('button', { name: '打开工作区导航' }).click();
  await chooseTheme(page, '浅色');
  await page.screenshot({ path: 'test-results/workspace/mobile-drawer.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await page.screenshot({ path: 'test-results/workspace/mobile-history-light.png' });
  await page.getByTestId('trace-tab').click();
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  await page.getByRole('button', { name: '打开工作区导航' }).click();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(page.getByTestId('composer-project-select')).toHaveCount(0);
  await page.getByTestId('thinking-trigger').click();
  await page.getByRole('radio', { name: 'medium', exact: true }).click();
  await expect(page.getByTestId('thinking-trigger')).toHaveText('medium');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('thinking-trigger')).toBeFocused();
  await page.screenshot({ path: 'test-results/workspace/mobile-new-light.png' });
  for (const viewport of [{ width: 1235, height: 390 }, { width: 2470, height: 780 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await page.getByTestId('composer-input').fill('隔离草稿');
    await page.getByTestId('model-thinking-trigger').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `test-results/workspace/new-${viewport.width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(unexpected).toEqual([]);
});

test('feedback: full-width summaries, heading states and SVG brand', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  const command = 'long command argument '.repeat(100).trim();
  const unexpected = await workspaceFixture(page, command);
  await page.setViewportSize({ width: 2470, height: 900 });
  await page.goto('/');
  await page.getByTestId('session-fixture-0').click();
  const card = page.getByTestId('tool-call-card').nth(2);
  const header = card.locator('.tool-call-header');
  const heading = card.locator('.tool-call-heading');
  const preview = card.locator('.tool-summary-preview');
  await expect(preview).toHaveAttribute('title', new RegExp(command));
  await expect(preview).toContainText(command);
  for (const expanded of [false, true]) {
    if (expanded) await header.click();
    await header.hover();
    await expect(header).toHaveAttribute('aria-expanded', String(expanded));
    const geometry = await card.evaluate(el => {
      const heading = el.querySelector('.tool-call-heading')!;
      const preview = el.querySelector('.tool-summary-preview')!;
      const icons = el.querySelector('.tool-header-icons')!;
      return { left: heading.getBoundingClientRect().left - el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right - heading.getBoundingClientRect().right,
        gap: icons.getBoundingClientRect().left - preview.getBoundingClientRect().right,
        background: getComputedStyle(heading).backgroundColor,
        hover: getComputedStyle(el).getPropertyValue('--bg-hover').trim(),
        bottomRadius: getComputedStyle(heading).borderBottomLeftRadius };
    });
    expect(geometry.left).toBe(1);
    expect(geometry.right).toBe(1);
    expect(geometry.gap).toBeLessThanOrEqual(9);
    expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(geometry.bottomRadius).toBe(expanded ? '0px' : '9px');
    await page.screenshot({ path: `test-results/workspace/feedback-${expanded ? 'expanded' : 'collapsed'}-hover.png` });
    await page.mouse.move(0, 0);
    await header.evaluate(el => (el as HTMLElement).blur());
    const restingHeading = await appearance(heading);
    await page.keyboard.press('Tab');
    await header.focus();
    expect(await header.evaluate(el => el.matches(':focus-visible'))).toBe(true);
    await expect(header).toBeFocused();
    await expect(header).toHaveCSS('outline-style', 'none');
    expect(await appearance(heading)).toEqual(restingHeading);
    if (expanded) await expect(card.locator('.tool-call-body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: `test-results/workspace/feedback-${expanded ? 'expanded' : 'collapsed'}-keyboard.png` });
  }
  await header.evaluate(el => (el as HTMLElement).blur());
  await header.click();
  await page.mouse.move(0, 0);
  await expect(heading).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const brand = page.locator('img.brand-mark');
  const checkBrand = async () => {
    await expect(brand).toBeVisible();
    const sourceUrl = await page.evaluate(async () => {
      const path = '/src/icons/svg/brand-pi.svg?import';
      return (await import(/* @vite-ignore */ path)).default as string;
    });
    await expect(brand).toHaveAttribute('src', sourceUrl);
    await expect(brand).toHaveAttribute('aria-hidden', 'true');
    await expect(brand).toHaveAttribute('alt', '');
    await expect.poll(() => brand.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const box = (await brand.boundingBox())!;
    expect(box.width).toBe(26);
    expect(box.height).toBe(26);
    const title = page.locator('.brand-text');
    await expect(title).toHaveText('pi-agent-server');
    const titleBox = (await title.boundingBox())!;
    expect(titleBox.x - box.x - box.width).toBe(8);
    expect(Math.abs(titleBox.y + titleBox.height / 2 - box.y - box.height / 2)).toBeLessThanOrEqual(0.5);
    await expect(page.locator('svg.brand-mark')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await checkBrand();
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(280);
  const lightBrandBox = await brand.boundingBox();
  const lightTitleBox = await page.locator('.brand-text').boundingBox();
  await page.screenshot({ path: 'test-results/workspace/feedback-desktop-light.png' });
  await chooseTheme(page, '深色');
  await checkBrand();
  expect(await brand.boundingBox()).toEqual(lightBrandBox);
  expect(await page.locator('.brand-text').boundingBox()).toEqual(lightTitleBox);
  await page.screenshot({ path: 'test-results/workspace/feedback-desktop-dark.png' });
  await page.keyboard.press('Tab');
  await header.focus();
  await expect(header).toBeFocused();
  await expect(header).toHaveCSS('outline-style', 'none');
  await page.screenshot({ path: 'test-results/workspace/focus-dark-heading.png' });
  await page.getByTestId('toggle-sidebar').click();
  await expect(brand).toBeHidden();
  await expect(page.locator('.brand-text')).toBeHidden();
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(56);
  await page.screenshot({ path: 'test-results/workspace/feedback-rail.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.locator('.tool-duration')).toBeVisible();
  const summaryBox = (await preview.boundingBox())!;
  const durationBox = (await card.locator('.tool-duration').boundingBox())!;
  expect(summaryBox.x + summaryBox.width).toBeLessThanOrEqual(durationBox.x);
  expect(durationBox.x + durationBox.width).toBeLessThan(390);
  await page.screenshot({ path: 'test-results/workspace/feedback-mobile-summary.png', animations: 'disabled' });
  await page.getByRole('button', { name: '打开工作区导航' }).click();
  await checkBrand();
  const mobileBrandBox = await brand.boundingBox();
  await page.screenshot({ path: 'test-results/workspace/feedback-mobile-brand.png', animations: 'disabled' });
  await chooseTheme(page, '浅色');
  await checkBrand();
  expect(await brand.boundingBox()).toEqual(mobileBrandBox);
  await page.screenshot({ path: 'test-results/workspace/feedback-mobile-brand-light.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  expect(unexpected).toEqual([]);
});

test('three sidebar fixes: vertical center <=1px, 12+ projects wide dropdown & pinned footer, unified x=16px alignment', async ({ page }) => {
  const unexpected = await workspaceFixture(page);
  const screenshotDir = '/tmp/pi-sidebar-three-fixes';
  await mkdir(screenshotDir, { recursive: true });

  const twelveProjects = [
    { id: 'default', name: '默认项目', cwd: '/workspace', isDefault: true },
    { id: 'pi-agent-server', name: 'pi-agent-server', cwd: '/repos/pi-agent-server', isDefault: false },
    { id: 'pi', name: '.pi', cwd: '/repos/.pi', isDefault: false },
    { id: 'onev-pro', name: 'onev-pro', cwd: '/repos/onev-pro', isDefault: false },
    { id: 'gfs-flowers', name: 'gfs-flowers', cwd: '/repos/gfs-flowers', isDefault: false },
    { id: 'support-center', name: 'support-center', cwd: '/repos/support-center', isDefault: false },
    { id: 'onev', name: 'onev', cwd: '/repos/onev', isDefault: false },
    { id: 'kow-cultivation', name: 'kow-cultivation', cwd: '/repos/kow-cultivation', isDefault: false },
    { id: 'mz', name: 'mz', cwd: '/repos/mz', isDefault: false },
    { id: 'stitch-google', name: 'stitch-google', cwd: '/repos/stitch-google', isDefault: false },
    { id: 'analytics-hub', name: 'analytics-hub', cwd: '/repos/analytics-hub', isDefault: false },
    { id: 'billing-app', name: 'billing-app', cwd: '/repos/billing-app', isDefault: false },
  ];

  await page.route('**/v1/projects', route => route.fulfill({ json: twelveProjects }));
  await page.route(/\/v1\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [
    { id: 'session-yesterday', projectId: 'pi-agent-server', title: '我部署到服务器上之后，/tmp 有...', createdAt: 1, updatedAt: Date.now() - 86400000, modelProvider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'off', systemPrompt: null },
    { id: 'session-today', projectId: 'pi-agent-server', title: '今天进行的项目排查与测试', createdAt: 2, updatedAt: Date.now() - 3600000, modelProvider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'off', systemPrompt: null },
  ] }));

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');

    const trigger = page.getByTestId('project-select');
    await expect(trigger).toBeVisible();

    // Switch to pi-agent-server project to test non-default selection
    await trigger.click();
    await page.getByRole('menuitemradio', { name: 'pi-agent-server', exact: true }).click();
    await expect(trigger).toContainText('pi-agent-server');
    await expect(page.locator('.session-title').first()).toBeVisible();

    // FIX 1: Project name, chevron, search SVG vertical centers on the same horizontal centerline (diff <= 1px)
    const centers = await page.evaluate(() => {
      const label = document.querySelector('.workbench-project-select .select-menu-label')!.getBoundingClientRect();
      const chevron = document.querySelector('.workbench-project-select .disclosure-chevron')!.getBoundingClientRect();
      const searchSvg = document.querySelector('.workbench-search-toggle svg')!.getBoundingClientRect();
      return {
        label: { y: label.y, h: label.height, cy: label.y + label.height / 2 },
        chevron: { y: chevron.y, h: chevron.height, cy: chevron.y + chevron.height / 2 },
        searchSvg: { y: searchSvg.y, h: searchSvg.height, cy: searchSvg.y + searchSvg.height / 2 },
      };
    });
    expect(Math.abs(centers.label.cy - centers.chevron.cy)).toBeLessThanOrEqual(1);
    expect(Math.abs(centers.label.cy - centers.searchSvg.cy)).toBeLessThanOrEqual(1);

    // FIX 3: Date group, session title, session time all unified at left x = 16px!
    const alignX = await page.evaluate(() => {
      const side = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect();
      const dateEl = document.querySelector('.session-date-group')!;
      const dateRange = document.createRange();
      dateRange.selectNodeContents(dateEl);
      const dateText = dateRange.getBoundingClientRect();
      const title = document.querySelector('.session-title')!.getBoundingClientRect();
      const time = document.querySelector('.session-time')!.getBoundingClientRect();
      const project = document.querySelector('.workbench-project-select .select-menu-label')!.getBoundingClientRect();
      return {
        sidebarWidth: side.width,
        dateX: dateText.x - side.x,
        titleX: title.x - side.x,
        timeX: time.x - side.x,
        projectX: project.x - side.x,
      };
    });
    expect(alignX.sidebarWidth).toBe(280);
    expect(alignX.dateX).toBe(16);
    expect(alignX.titleX).toBe(16);
    expect(alignX.timeX).toBe(16);
    expect(alignX.projectX).toBe(16);

    // Capture sidebar alignment screenshot
    if (theme === 'light') {
      await page.screenshot({ path: `${screenshotDir}/sidebar-alignment-16-16-16.png` });
    }

    // Measure sidebar before opening popup
    const sidebarBefore = await page.evaluate(() => {
      const side = document.querySelector('[data-testid="sidebar"]')!;
      const search = document.querySelector('.workbench-search-toggle')!.getBoundingClientRect();
      return {
        scrollWidth: side.scrollWidth,
        clientWidth: side.clientWidth,
        scrollHeight: side.scrollHeight,
        clientHeight: side.clientHeight,
        searchBox: { x: search.x, y: search.y, width: search.width, height: search.height },
      };
    });

    // FIX 2: Open project dropdown in 280 sidebar
    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible();

    // Verify popup does not expand sidebar scrollWidth or scrollHeight
    const sidebarAfter = await page.evaluate(() => {
      const side = document.querySelector('[data-testid="sidebar"]')!;
      const search = document.querySelector('.workbench-search-toggle')!.getBoundingClientRect();
      return {
        scrollWidth: side.scrollWidth,
        clientWidth: side.clientWidth,
        scrollHeight: side.scrollHeight,
        clientHeight: side.clientHeight,
        searchBox: { x: search.x, y: search.y, width: search.width, height: search.height },
      };
    });
    expect(sidebarAfter.scrollWidth).toBe(sidebarBefore.scrollWidth);
    expect(sidebarAfter.scrollHeight).toBe(sidebarBefore.scrollHeight);
    expect(sidebarAfter.searchBox).toEqual(sidebarBefore.searchBox);

    // Verify dropdown width matches row (~249px) and pi-agent-server is NOT truncated with ellipsis
    const optionCheck = await page.evaluate(() => {
      const menu = document.querySelector('.select-menu-listbox')!.getBoundingClientRect();
      const side = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect();
      const activeOption = document.querySelector('.select-menu-option[aria-checked="true"] .select-menu-label-text')!;
      const optionsList = document.querySelector('.select-menu-options')!;
      return {
        menuWidth: menu.width,
        menuLeft: menu.left - side.left,
        textClipped: activeOption.scrollWidth > activeOption.clientWidth,
        optionsScrollable: optionsList.scrollHeight > optionsList.clientHeight,
      };
    });
    expect(optionCheck.menuWidth).toBeGreaterThanOrEqual(240);
    expect(optionCheck.menuLeft).toBe(16);
    expect(optionCheck.textClipped).toBe(false); // pi-agent-server completely visible, not truncated!
    expect(optionCheck.optionsScrollable).toBe(true); // 12+ items scroll independently

    // Verify pinned footer "+ 新建项目" is visible
    const newProjectBtn = page.getByTestId('new-project');
    await expect(newProjectBtn).toBeVisible();

    // Scroll options to bottom and verify footer is STILL visible
    await page.evaluate(() => {
      const optionsList = document.querySelector('.select-menu-options')!;
      optionsList.scrollTop = optionsList.scrollHeight;
    });
    await expect(newProjectBtn).toBeVisible();

    await page.screenshot({ path: `${screenshotDir}/280-dropdown-open-${theme}.png` });

    // Keyboard navigation tests in light mode
    if (theme === 'light') {
      const menu = page.getByRole('menu');
      // End navigates to new project footer action
      await page.keyboard.press('End');
      await expect(newProjectBtn).toHaveAttribute('data-active', 'true');
      // Enter opens project creation dialog
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('project-create-form')).toBeVisible();
      // Escape closes create dialog and restores focus
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('project-create-form')).toBeHidden();
      await expect(trigger).toBeFocused();

      // Test 180 narrow sidebar
      const handle = (await page.locator('.resize-handle.sidebar').boundingBox())!;
      const sidebarBox = (await page.getByTestId('sidebar').boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + (180 - sidebarBox.width), handle.y + 100);
      await page.mouse.up();
      if ((await page.getByTestId('sidebar').boundingBox())!.width === 56) {
        await page.getByTestId('toggle-sidebar').click();
      }
      expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(180);

      await trigger.click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(newProjectBtn).toBeVisible();
      expect(await page.evaluate(() => document.querySelector('[data-testid="sidebar"]')!.scrollWidth <= 180)).toBe(true);
      await page.screenshot({ path: `${screenshotDir}/180-narrow-light.png` });
      await page.keyboard.press('Escape');

      // Test 400 wide sidebar
      const currentBox = (await page.getByTestId('sidebar').boundingBox())!;
      const handle2 = (await page.locator('.resize-handle.sidebar').boundingBox())!;
      await page.mouse.move(handle2.x + handle2.width / 2, handle2.y + 100);
      await page.mouse.down();
      await page.mouse.move(handle2.x + handle2.width / 2 + (400 - currentBox.width), handle2.y + 100);
      await page.mouse.up();
      expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(400);

      await trigger.click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(newProjectBtn).toBeVisible();
      await page.screenshot({ path: `${screenshotDir}/400-wide-light.png` });
      await page.keyboard.press('Escape');
    } else {
      await page.keyboard.press('Escape');
    }

    // Test mobile 390
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '打开工作区导航' }).click();
    await expect(page.getByTestId('sidebar')).toBeVisible();

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
    expect(Math.abs(mobileCenters.label.cy - mobileCenters.chevron.cy)).toBeLessThanOrEqual(1);
    expect(Math.abs(mobileCenters.label.cy - mobileCenters.searchSvg.cy)).toBeLessThanOrEqual(1);

    // Verify touch targets >= 44px
    for (const target of [page.getByTestId('project-select'), page.getByRole('button', { name: '搜索会话', exact: true })]) {
      const box = (await target.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    // Open project dropdown on mobile
    await page.getByTestId('project-select').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByTestId('new-project')).toBeVisible();
    await page.screenshot({ path: `${screenshotDir}/390-mobile-${theme}.png` });
    await page.keyboard.press('Escape');
  }

  expect(unexpected).toEqual([]);
});
