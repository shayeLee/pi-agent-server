import { test, expect } from "@playwright/test";

test("端到端：内网免登录 → 新建会话 → 发消息 → SSE 流式显示回答", async ({ page }) => {
  await page.goto("/");

  // 内网（127.0.0.1）免 token，探测成功后直接进入会话列表
  await expect(page.getByTestId("new-session")).toBeVisible();

  // 新建会话
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("chat")).toBeVisible();

  // 发送消息
  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("send-button").click();

  // 用户消息立即上屏
  await expect(page.getByTestId("message-list")).toContainText("你好");

  // SSE 流式回答（mock 后端推送两段 text_delta）
  await expect(page.getByTestId("message-list")).toContainText("你好，我是 pi-agent-server 测试助手");
});

test("端到端：会话列表展示与删除", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("chat")).toBeVisible();

  // 刷新页面确保列表稳定（mock DB 跨测试共享，避免异步加载导致计数竞态）
  await page.reload();
  await expect(page.getByTestId("new-session")).toBeVisible();

  // 删除在会话行尾的 ⋯ 菜单中（DESIGN.md §7）。
  const rows = page.locator(".session-item");
  const before = await rows.count();
  expect(before).toBeGreaterThan(0);
  await rows.first().hover();
  await rows.first().locator('[data-testid^="session-menu-"]').click();
  await page.locator('[data-testid^="delete-"]').click();
  await expect(rows).toHaveCount(before - 1);
});
