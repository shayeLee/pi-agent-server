import { expect, test } from "@playwright/test";
import { failOnUnexpectedRequest } from "./unexpected-request";

for (const theme of ["light", "dark"]) {
  test(`isolated cursor matrix and cancellation (${theme})`, async ({ page }, testInfo) => {
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:5298" || /^\/(v1|health)(\/|$)/.test(url.pathname)) return failOnUnexpectedRequest(page, route, unexpected, url.href);
      return route.continue();
    });
    await page.setViewportSize({ width: 1000, height: 1100 });
    await page.goto(`/visual-fixtures/message-cursor.html?theme=${theme}`);
    const cursor = ".streaming-cursor";
    for (const streaming of [true, false]) {
      for (const index of [0, 1]) {
        await expect(page.getByTestId(`case-${streaming}-${index}`).locator(cursor)).toHaveCount(streaming ? 1 : 0);
      }
    }
    const region = page.getByTestId("cancel-region");
    await expect(page.getByTestId("thinking-cancel-empty-thinking")).toHaveCount(0);
    // Thinking starts collapsed even while streaming. Open it and keep it open across
    // cancellation so hidden content cannot mask a stale cursor.
    await region.getByRole("button", { name: "思考过程" }).click();
    await expect(region.locator(cursor)).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath(`cursor-${theme}-before.png`), fullPage: true });
    await page.getByRole("button", { name: "模拟取消 / 放弃" }).click();
    await expect(region.locator(cursor)).toHaveCount(0);
    await expect(page.getByTestId("message-cancel-empty")).toBeAttached();
    await expect(page.getByTestId("message-cancel-empty").locator(".assistant-content")).toBeEmpty();
    await expect(page.getByTestId("message-cancel-text")).toHaveText("取消后保留这段文本。");
    await expect(page.getByTestId("thinking-body-cancel-thinking")).toBeVisible();
    await expect(region.getByRole("button", { name: "思考过程" })).toHaveText("思考");
    await page.screenshot({ path: testInfo.outputPath(`cursor-${theme}-cancelled.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath(`cursor-${theme}-mobile-cancelled.png`), fullPage: true });
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
