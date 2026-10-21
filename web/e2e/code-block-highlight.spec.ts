import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
  test(`safe highlighted snapshots / ${theme} / ${width}`, async ({ page, context }) => {
    await mkdir("/tmp/code-block-highlight", { recursive: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    await page.goto(`/visual-fixtures/code-block.html?theme=${theme}`);
    // A running step starts collapsed; open it to follow the snapshots.
    await expect(page.locator(".tool-call-header")).toHaveAttribute("aria-expanded", "false");
    await page.locator(".tool-call-header").click();
    const result = page.locator(".tool-result-text");
    const source = result.locator("pre");
    await expect(source).toHaveText('<!doctype html>\n<html lang="zh-CN">\n');
    await page.screenshot({ path: `/tmp/code-block-highlight/stream-first-${theme}-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "更新工具快照" }).click();
    await expect(source).toContainText("工业视觉智能检测数据大屏");
    const original = await page.evaluate(async () => (await import('/visual-fixtures/code-block.tsx')).html);
    expect(await source.textContent()).toBe(original);
    await expect(result.locator(".code-block")).toHaveAttribute("data-language", "html");
    expect(await result.locator(".hljs-name").count()).toBeGreaterThan(0);
    const colors = await result.evaluate(element => ({ name: getComputedStyle(element.querySelector('.hljs-name')!).color, attr: getComputedStyle(element.querySelector('.hljs-attr')!).color, base: getComputedStyle(element.querySelector('code')!).color }));
    expect(colors.name).not.toBe(colors.attr);
    expect(colors.name).not.toBe(colors.base);
    expect(colors.name).toBe(theme === "dark" ? "rgb(150, 198, 255)" : "rgb(36, 92, 166)");
    expect(await page.evaluate(() => (window as unknown as { __executed?: boolean }).__executed)).toBeUndefined();
    await expect(result.locator("script, img, iframe")).toHaveCount(0);
    await result.getByRole("button", { name: "复制代码" }).click();
    await expect(result.getByRole("status")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
    await result.getByRole("button", { name: "复制代码" }).click();
    await expect(result.getByRole("status")).toContainText("复制失败");
    await expect(page.locator(".markdown p code")).toHaveText("const inline = 1");
    expect(await page.locator('.markdown [data-language="typescript"] pre').textContent()).toBe('const greeting: string = "你好";\n\n');
    expect(await page.locator('.markdown [data-language="json"] .hljs-attr').count()).toBe(2);
    await expect(page.locator('.markdown [data-language="plain"] span[class^="hljs-"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    const overflow = await source.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, mode: getComputedStyle(element).overflowX }));
    expect(overflow.scroll).toBeGreaterThan(overflow.client);
    expect(overflow.mode).toBe("auto");
    await page.screenshot({ path: `/tmp/code-block-highlight/highlight-${theme}-${width}.png`, fullPage: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
