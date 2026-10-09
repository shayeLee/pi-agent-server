import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
  test(`unified tool code / ${theme} / ${width}`, async ({ page, context }) => {
    await mkdir("/tmp/unified-tool-codeblock", { recursive: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`/visual-fixtures/unified-tool-codeblock.html?theme=${theme}`);
    const originals = await page.evaluate(async () => {
      const { partial, final, args } = await import("/visual-fixtures/unified-tool-codeblock.tsx");
      return { partial, final, args: JSON.stringify(args, null, 2) };
    });
    const header = page.locator(".tool-call-header");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await header.click();
    await header.click(); // Explicit manual expansion survives completion.
    const output = page.getByTestId("tool-result-text");
    expect(await output.locator('[data-language="bash"] pre').textContent()).toBe(originals.partial);
    await expect(page.getByRole("button", { name: "Markdown 展示" })).toHaveCount(0);
    await page.getByRole("button", { name: "完成快照" }).click();
    expect(await output.locator('[data-language="bash"] pre').textContent()).toBe(originals.final);
    await expect(page.getByTestId("tool-call-card")).toHaveAttribute("data-done", "true");
    await expect(page.getByText("部分结果原始数据", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "工具更多操作" }).click();
    await page.getByRole("menuitem", { name: "查看原始数据" }).click();
    const details = page.getByRole("dialog", { name: "原始数据 · bash" });
    await expect(details).toBeVisible();
    await expect(details.locator(".code-block")).toHaveAttribute("data-language", "json");
    const source = details.getByLabel("代码原文");
    await expect(source).toBeVisible();
    const raw = (await source.textContent())!;
    expect(JSON.parse(raw).args).toEqual(JSON.parse(originals.args));
    expect(JSON.parse(raw).result).toBe(originals.final);
    await details.getByRole("button", { name: "复制原始数据" }).click();
    await expect(details.getByRole("status")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
    await page.screenshot({ path: `/tmp/unified-tool-codeblock/${theme}-${width}.png`, fullPage: true });
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
    await details.getByRole("button", { name: "复制原始数据" }).click();
    await expect(page.getByText("复制失败，请选择原文复制", { exact: true })).toHaveCount(1);
    expect(await source.textContent()).toBe(raw);
    for (const block of await page.locator(".code-block").all()) {
      const geometry = await block.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const button = element.querySelector("button")!.getBoundingClientRect();
        const toolbar = element.querySelector(".code-block-toolbar")!.getBoundingClientRect();
        return { contained: button.left >= bounds.left && button.right <= bounds.right && button.top >= bounds.top && button.bottom <= bounds.bottom,
          right: bounds.right - button.right, top: button.top - bounds.top, header: toolbar.bottom <= element.querySelector("pre")!.getBoundingClientRect().top };
      });
      expect(geometry.contained).toBe(true);
      expect(geometry.right).toBeLessThanOrEqual(10);
      expect(geometry.top).toBeLessThanOrEqual(4);
      expect(geometry.header).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, "__executed"))).toBeUndefined();
    await expect(page.locator("script:not([type=module]), .tool-call img")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/unified-tool-codeblock/${theme}-${width}-copy-failure.png`, fullPage: true });
  });
}
