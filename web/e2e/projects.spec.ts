import { test, expect } from "@playwright/test";

test("多项目：创建额外项目 → 建会话归属项目 → 切换项目隔离会话 → 验证无删除入口", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();

  // Project discovery lists projects with visible sessions. Establish the default
  // project through the real create/send path instead of assuming an empty seed is listed.
  await page.getByTestId("composer-input").fill("默认项目隔离前置会话");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant")).toContainText("pi-agent-server 测试助手");
  await expect(page.getByTestId("abort-button")).toHaveCount(0);

  // 与 mock 后端 seed 一致：默认项目 id = 服务端 DEFAULT_PROJECT_ID（Web 由 isDefault 字段推导）
  const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
  const projectName = `我的仓库-${Date.now()}`;
  const trigger = page.getByTestId("project-select");
  const listboxId = await trigger.getAttribute("aria-controls");
  const projectList = page.locator(`[id="${listboxId}"]`);
  await expect(trigger).toHaveAttribute("data-value", DEFAULT_PROJECT_ID);

  // 通过下拉菜单中的「新建项目」创建额外项目
  await trigger.click();
  await page.getByTestId("new-project").click();
  await page.getByTestId("project-name-input").fill(projectName);
  await page.getByTestId("project-cwd-input").fill("/tmp/my-repo");
  await page.getByTestId("project-create-submit").click();
  await expect(trigger).toHaveText(projectName);
  await trigger.click();
  const currentListboxId = await trigger.getAttribute("aria-controls");
  const activeList = page.locator(`[id="${currentListboxId}"]`);
  await expect(activeList.getByRole("menuitemradio", { name: projectName })).toHaveCount(1);
  await page.keyboard.press("Escape");

  // 在额外项目中建一个会话并重命名为唯一标题
  await expect(trigger).not.toHaveAttribute("data-value", DEFAULT_PROJECT_ID);
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("chat")).toBeVisible();
  await page.getByTestId("composer-input").fill("用于测试项目隔离");
  await page.getByTestId("send-button").click();
  await expect(page.locator('[data-testid^="session-menu-"]').first()).toBeAttached();
  await expect(page.getByTestId("abort-button")).toHaveCount(0);

  const uniqueTitle = `项目会话-${Date.now()}`;
  // Rename lives in the row's ⋯ menu (DESIGN.md §7) and opens an in-app dialog.
  await page.locator('[data-testid^="session-menu-"]').first().click();
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await page.getByTestId("rename-input").fill(uniqueTitle);
  await page.getByTestId("rename-save").click();
  await expect(page.getByText(uniqueTitle).first()).toBeVisible();

  // 切回默认项目：不该出现额外项目的会话
  await trigger.click();
  const returnListboxId = await trigger.getAttribute("aria-controls");
  await page.locator(`[id="${returnListboxId}"]`).getByRole("menuitemradio", { name: "默认项目" }).click();
  await expect(page.getByText(uniqueTitle)).toHaveCount(0);

  // 切回额外项目，验证 Web UI 不暴露项目删除入口（不提供删除入口与请求）
  await trigger.click();
  const extraListboxId = await trigger.getAttribute("aria-controls");
  await page.locator(`[id="${extraListboxId}"]`).getByRole("menuitemradio", { name: projectName }).click();
  await trigger.click();
  await expect(page.getByTestId("delete-project")).toHaveCount(0);
  await expect(page.getByText("删除当前项目")).toHaveCount(0);
  await expect(page.getByText("删除项目")).toHaveCount(0);

  // 再次切回默认项目确认状态正常
  const finalListboxId = await trigger.getAttribute("aria-controls");
  await page.locator(`[id="${finalListboxId}"]`).getByRole("menuitemradio", { name: "默认项目" }).click();
  await expect(trigger).toHaveAttribute("data-value", DEFAULT_PROJECT_ID);
});
