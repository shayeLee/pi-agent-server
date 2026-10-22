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
      // Title stays on one line, truncated; the full text stays available in its title attribute (DESIGN.md §3.1).
      const titleBox = await page.locator('.session-title-main').evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), truncated: el.scrollWidth > el.clientWidth, full: el.getAttribute('title') === el.textContent }));
      if (long) expect(titleBox.truncated).toBe(true);
      expect(titleBox.height).toBeLessThanOrEqual(titleBox.line + 1);
      expect(titleBox.full).toBe(true);
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
    } else if (hit === 'time') {
      // Hover swaps the time for ⋯ in place (DESIGN.md §7), so aim at the time's left end,
      // which a short time like "10分钟" leaves outside the menu button.
      await page.getByTestId('session-time-fixture-0').click({ position: { x: 2, y: 6 } });
    }
    else if (hit === 'title') await select.locator('.session-title').click();
    else { await select.focus(); await page.keyboard.press(hit); }
    await expect(select).toHaveAttribute('aria-current', 'true');
    expect(await count()).toBe(1);
  }
  await reset();
  // Row actions live in the ⋯ menu (DESIGN.md §7); rename opens an in-app dialog.
  await page.getByTestId('session-menu-fixture-1').click();
  await page.getByTestId('rename-fixture-1').click();
  await expect(page.getByTestId('rename-input')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rename-input')).toBeHidden();
  expect(await count()).toBe(0);
  const download = page.waitForEvent('download');
  // The ⋯ button is revealed by hovering (or focusing) its row.
  await page.getByTestId('session-fixture-1').hover();
  await page.getByTestId('session-menu-fixture-1').click();
  await page.getByTestId('export-fixture-1').click();
  await download;
  await page.getByTestId('session-menu-fixture-1').click();
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
  // Selecting a row closes the drawer (the current row shows ⋯ in its time slot, so click the row itself).
  await page.getByTestId('session-fixture-0').click();
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
  await page.getByTestId('settings-toggle').click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}

test('isolated two-column workspace, disclosures, menus, drafts and responsive themes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const unexpected = await workspaceFixture(page);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/');
  await page.getByTestId('session-fixture-0').click();
  await expect(page.getByTestId('tool-call-card')).toHaveCount(4);
  // Finished tool steps start folded inside work blocks.
  for (const block of await page.locator('.work-header[aria-expanded="false"]').all()) await block.click();
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
  await page.screenshot({ path: 'test-results/workspace/desktop-light.png' });
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


