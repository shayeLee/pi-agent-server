import { test, expect } from "@playwright/test";

test("端到端：内网免登录 → 新建会话 → 发消息 → SSE 流式显示回答", async ({ page }) => {
  await page.goto("/");

  // 内网（127.0.0.1）免 token，探测成功后直接进入会话列表
  await expect(page.getByTestId("new-session")).toBeVisible();

  // 新建会话
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("chat-view")).toBeVisible();

  // 发送消息
  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("send-button").click();

  // 用户消息立即上屏
  await expect(page.getByTestId("message-list")).toContainText("你好");

  // SSE 流式回答（mock 后端推送两段 text_delta）
  await expect(page.getByTestId("message-list")).toContainText("你好，我是 pi-server 测试助手");
});

test("端到端：会话列表展示与删除", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("chat-view")).toBeVisible();

  // 会话列表里有会话（delete- 按钮说明有会话项）
  const deleteButtons = page.locator('[data-testid^="delete-"]');
  const before = await deleteButtons.count();
  expect(before).toBeGreaterThan(0);

  // 删除刚建的会话 → 删除按钮数量减一（mock 服务内存库跨测试共享，不假设列表为空）
  await deleteButtons.first().click();
  await expect(deleteButtons).toHaveCount(before - 1);
});
