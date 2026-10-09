import { test, expect } from "@playwright/test";

test("多项目：创建额外项目 → 建会话归属项目 → 切换项目隔离会话 → 删除项目级联", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();

  // 与 mock 后端 seed 一致：默认项目 id = 服务端 DEFAULT_PROJECT_ID（Web 由 isDefault 字段推导）
  const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
  const projectName = `我的仓库-${Date.now()}`;
  const trigger = page.getByTestId("project-select");
  const listboxId = await trigger.getAttribute("aria-controls");
  const projectList = page.locator(`[id="${listboxId}"]`);
  await expect(trigger).toHaveAttribute("data-value", DEFAULT_PROJECT_ID);

  // 创建额外项目
  await page.getByTestId("new-project").click();
  await page.getByTestId("project-name-input").fill(projectName);
  await page.getByTestId("project-cwd-input").fill("/tmp/my-repo");
  await page.getByTestId("project-create-submit").click();
  await trigger.click();
  await expect(projectList.getByRole("option", { name: projectName })).toHaveCount(1);

  // 切到额外项目，建一个会话并重命名为唯一标题
  await projectList.getByRole("option", { name: projectName }).click();
  await expect(trigger).not.toHaveAttribute("data-value", DEFAULT_PROJECT_ID);
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("chat")).toBeVisible();
  await page.getByTestId("composer-input").fill("用于测试项目隔离");
  await page.getByTestId("send-button").click();
  await expect(page.locator('[data-testid^="rename-"]').first()).toBeAttached();

  const uniqueTitle = `项目会话-${Date.now()}`;
  page.once("dialog", (d) => d.accept(uniqueTitle));
  const rename = page.locator('[data-testid^="rename-"]').first();
  await rename.locator("xpath=ancestor::li[contains(@class, 'session-item')]").hover();
  await rename.click();
  await expect(page.getByText(uniqueTitle).first()).toBeVisible();

  // 切回默认项目：不该出现额外项目的会话
  await trigger.click();
  await projectList.getByRole("option", { name: "默认项目" }).click();
  await expect(page.getByText(uniqueTitle)).toHaveCount(0);

  // 切回额外项目，删除项目（级联删除其下会话）
  await trigger.click();
  await projectList.getByRole("option", { name: projectName }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("delete-project").click();
  await expect(trigger).toHaveAttribute("data-value", DEFAULT_PROJECT_ID);
  await trigger.click();
  await expect(projectList.getByRole("option", { name: projectName })).toHaveCount(0);
});
