import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`富内容组件视觉与展开：${theme} / ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.goto(`/visual-fixtures/rich.html?theme=${theme}`);
      await expect(page.getByTestId("tool-call-card")).toHaveCount(3);
      await page.getByTestId("thinking-thinking-fixture").getByRole("button").click();
      await expect(page.getByTestId("thinking-body-thinking-fixture")).toContainText("错误边界");
      for (const card of await page.getByTestId("tool-call-card").all()) {
        const header = card.locator(".tool-call-header");
        // Running or done, every step starts collapsed until the reader opens it.
        await expect(header).toHaveAttribute("aria-expanded", "false");
        await header.click();
        await expect(card.locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
        await expect(card.locator(".tool-call-body")).toBeVisible();
      }
      await expect(page.getByTestId("tool-call-card").nth(2).getByRole("img", { name: "失败" })).toBeVisible();
      await expect(page.locator(".assistant-content pre")).toContainText("handleRequest");
      await page.getByTestId("event-3").locator("summary").click();
      await expect(page.getByTestId("event-3")).toHaveAttribute("open", "");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow, "富内容不得使页面横向溢出").toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`rich-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
    });
  }
}
