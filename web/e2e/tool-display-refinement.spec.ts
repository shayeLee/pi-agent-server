import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`tool display ${theme} ${width}`, async ({ page, context }) => {
    await mkdir("/tmp/tool-display-refinement", { recursive: true });
    await mkdir("/tmp/tool-edit-codeblock", { recursive: true });
    await mkdir("/tmp/file-tool-clean", { recursive: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`/visual-fixtures/tool-display-refinement.html?theme=${theme}`);
    const originals = await page.evaluate(async () => {
      const { command, content, editOld, editNew, edits } = await import("/visual-fixtures/tool-display-refinement.tsx");
      return { command, content, editOld, editNew, edits };
    });
    const bash = page.locator('[data-tool-call-id="bash"]');
    const header = bash.getByRole("button", { name: /工具调用/ });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    expect(await header.locator(".tool-summary-preview").textContent()).toContain(originals.command.slice(0, 100));
    await page.mouse.move(width - 1, 0);
    await header.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(header).toBeFocused();
    await expect(header.locator(".tool-toggle")).toHaveCSS("opacity", "1");
    const layout = await header.evaluate(el => {
      const style = getComputedStyle(el);
      const preview = el.querySelector(".tool-summary-preview")!;
      const badge = el.querySelector(".tool-status-icon")!.getBoundingClientRect();
      const arrow = el.querySelector(".tool-toggle")!.getBoundingClientRect();
      return { outline: style.outlineStyle, shadow: style.boxShadow, wrapping: getComputedStyle(preview).whiteSpace,
        truncated: preview.textContent!.includes("…"), size: arrow.width, gap: arrow.left - badge.right,
        centered: Math.abs(arrow.y + arrow.height / 2 - badge.y - badge.height / 2),
        contained: arrow.right <= el.getBoundingClientRect().right,
        opacity: getComputedStyle(el.querySelector(".tool-toggle")!).opacity };
    });
    expect(layout).toMatchObject({ outline: "none", shadow: "none", wrapping: "nowrap", truncated: true, size: 12, contained: true, opacity: "1" });
    // The workspace header separates status and disclosure with flexible space.
    // Both remain distinct, contained and vertically aligned at every viewport.
    expect(layout.gap).toBeGreaterThanOrEqual(12);
    expect(layout.centered).toBeLessThan(1);
    await page.screenshot({ path: `/tmp/tool-display-refinement/${theme}-${width}-collapsed-keyboard.png`, fullPage: true });
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    expect(await bash.getByRole('region', { name: '参数', exact: true }).locator('[data-language="bash"] pre').textContent()).toBe(originals.command);
    await page.keyboard.press("Space");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    for (const id of ["write", "edit-single", "edit-batch", "edit-plain"]) {
      const header = page.locator(`[data-tool-call-id="${id}"] .tool-call-header`);
      if (await header.getAttribute("aria-expanded") === "false") await header.click();
    }
    const write = page.locator('[data-tool-call-id="write"]');
    const code = write.locator('[data-language="python"]');
    expect(await code.locator("pre").textContent()).toBe(originals.content);
    expect(await code.locator('span[class^="hljs-"]').count()).toBeGreaterThan(0);
    const colors = await code.locator(".hljs-keyword").first().evaluate(el => ({ token: getComputedStyle(el).color, base: getComputedStyle(el.closest("code")!).color }));
    expect(colors.token).not.toBe(colors.base);
    await code.getByRole("button", { name: "复制代码" }).click();
    await expect(code.getByRole("status")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(originals.content);
    await expect(write.locator('dt').filter({ hasText: /^(path|content)$/ })).toHaveCount(0);
    for (const id of ['write', 'edit-single', 'edit-batch']) {
      const card = page.locator(`[data-tool-call-id="${id}"]`);
      await expect(card.getByRole('region', { name: '结果', exact: true })).toHaveCount(0);
      await expect(card).not.toContainText('Successfully');
    }
    await expect(write.locator('.tool-call-body > :not(section)')).toHaveCount(0);
    const single = page.locator('[data-tool-call-id="edit-single"]');
    await expect(single.locator('.diff-delete').first()).toContainText('- ');
    await expect(single.locator('.diff-add').first()).toContainText('+ ');
    await expect(single.locator('.diff-no-newline')).toHaveCount(0);
    const singleParams = single.getByRole('region', { name: '参数' });
    await expect(singleParams.locator('dt').filter({ hasText: /^path$/ })).toHaveCount(0);
    await expect(singleParams.locator('dt').filter({ hasText: /^edits$/ })).toHaveCount(0);
    await expect(singleParams.locator('dt').filter({ hasText: /修改前|修改后|oldText|newText/ })).toHaveCount(0);
    await expect(singleParams.locator('dt').filter({ hasText: /^flag$/ })).toBeVisible();
    await expect(singleParams.locator('dd').filter({ hasText: /^false$/ })).toBeVisible();
    await expect(singleParams.locator('dt').filter({ hasText: /^count$/ })).toBeVisible();
    await expect(singleParams.locator('dd').filter({ hasText: /^0$/ })).toBeVisible();
    const singleDiff = singleParams.locator('.diff-block');
    await expect(singleDiff.locator('details, .code-block, [title], [aria-description]')).toHaveCount(0);
    await expect(singleDiff.locator('.diff-lines')).toHaveText('  def greet(name):\n-     print("old", name)\n- last\n+     print("new", name)\n+ last\n');
    const batch = page.locator('[data-tool-call-id="edit-batch"]');
    const batchParams = batch.getByRole('region', { name: '参数' });
    await expect(batchParams.locator('dt').filter({ hasText: /^path$/ })).toHaveCount(0);
    await expect(batchParams.locator('dt').filter({ hasText: /^edits$/ })).toHaveCount(0);
    await expect(batchParams.locator('.diff-block')).toHaveCount(4);
    await expect(batchParams.locator('.diff-block').nth(3)).toContainText('片段相同');
    await expect(batchParams.locator('.diff-block').locator('details, .code-block, [title], [aria-description]')).toHaveCount(0);
    await expect(batchParams.locator('.diff-block').nth(0).locator('.diff-delete')).toHaveText('- const n: number = 0;');
    await expect(batchParams.locator('.diff-block').nth(0).locator('.diff-add')).toHaveText('+ const n: number = 1;');
    await expect(batchParams.locator('.diff-block').nth(1).locator('.diff-add')).toHaveText('+   <img onerror="window.__executed=1">');
    await expect(batchParams.locator('.diff-block').nth(2).locator('.diff-delete')).toHaveText('- removed');
    await page.screenshot({ path: `/tmp/tool-edit-codeblock/${theme}-${width}-diff.png`, fullPage: true });
    for (const card of [single, batch]) await expect(card.locator('.tool-call-body > :not(section)')).toHaveCount(0);
    const plain = page.locator('[data-tool-call-id="edit-plain"]');
    await expect(plain.locator('details, .code-block')).toHaveCount(0);
    await expect(page.locator('.diff-block img, .diff-block script')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/tool-edit-codeblock/${theme}-${width}-clean-diff.png`, fullPage: true });
    for (const header of await page.locator('[data-tool-call-id^="empty-"] .tool-call-header').all()) await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-tool-call-id^="empty-"] .json-block')).toHaveCount(0);
    await expect(page.locator('[data-tool-call-id^="empty-"] dialog[open]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, "__executed"))).toBeUndefined();
    await page.getByRole("button", { name: "Other button" }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await page.getByRole("button", { name: "Other button" }).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await page.screenshot({ path: `/tmp/tool-display-refinement/${theme}-${width}-write.png`, fullPage: true });
    await page.screenshot({ path: `/tmp/file-tool-clean/${theme}-${width}.png`, fullPage: true });
  });
}
