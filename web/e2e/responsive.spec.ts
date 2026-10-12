import { test, expect } from "@playwright/test";

test("桌面侧栏折叠后缩窄视口，移动抽屉仍保留项目与会话操作", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1024 });
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();
  await page.getByTestId("new-session").click();
  await page.getByTestId("composer-input").fill("用于测试响应式会话");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".session-item").first()).toBeAttached();
  await page.getByTestId("toggle-sidebar").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开工作区导航" }).click();
  await expect(page.getByTestId("project-select")).toBeVisible();
  await page.getByTestId("project-select").click();
  await page.getByTestId("new-project").click();
  await expect(page.getByTestId("project-create-form")).toBeVisible();
  await page.getByRole("button", { name: "搜索会话" }).click();
  await expect(page.getByTestId("session-search")).toBeVisible();
  await page.locator(".session-item").first().getByRole("button").first().focus();
  await expect(page.locator('[data-testid^="delete-"]').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("collapsed-to-mobile-drawer.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toBeHidden();
});
