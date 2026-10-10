import { test, expect } from "@playwright/test";

for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
  test(`${theme} ${mobile ? "mobile" : "desktop"}: isolated state transitions`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 360, height: 780 } : { width: 1280, height: 860 });
    const apiRequests: string[] = [];
    await page.route("**/api/**", route => { apiRequests.push(route.request().url()); return route.abort(); });
    await page.goto(`/visual-fixtures/compaction.html?theme=${theme}`);
    const banner = page.getByTestId("compaction-banner");
    const indicator = banner.locator(".compaction-indicator");
    await expect(banner).toContainText("正在压缩上下文…");
    await expect(indicator).toHaveCSS("animation-name", "compaction-pulse");
    const composer = await page.locator(".composer").boundingBox();
    const bounds = await banner.boundingBox();
    expect(bounds!.x).toBe(composer!.x);
    expect(bounds!.width).toBe(composer!.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(composer!.y);
    await page.screenshot({ path: testInfo.outputPath("running.png"), fullPage: true });
    await page.getByLabel("模拟连接").uncheck();
    await expect(banner).toContainText("压缩状态待确认 / 连接中断");
    await expect(indicator).toHaveCSS("animation-name", "none");
    await page.screenshot({ path: testInfo.outputPath("disconnected.png"), fullPage: true });
    await page.getByLabel("模拟连接").check();
    await expect(banner).toContainText("正在压缩上下文…");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(indicator).toHaveCSS("animation-name", "none");
    for (const [status, text] of [["succeeded", "上下文已压缩"], ["failed", "上下文压缩失败"], ["aborted", "上下文压缩已取消"], ["unknown", "压缩状态待确认"]]) {
      await page.getByLabel("模拟状态").selectOption(status);
      await expect(banner).toContainText(text);
      await expect(indicator).toHaveCSS("animation-name", "none");
      if (status === "succeeded") await expect(banner).toContainText("压缩后（估算）1,234,567,890,123 tokens");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await banner.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${status}.png`), fullPage: true });
    }
    await page.getByLabel("模拟状态").selectOption("hidden");
    await expect(banner).toHaveCount(0);
    expect(apiRequests).toEqual([]);
  });
}
