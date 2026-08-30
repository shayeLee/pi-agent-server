import { test, expect } from "@playwright/test";

test("多项目：创建额外项目 → 建会话归属项目 → 切换项目隔离会话 → 删除项目级联", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();

  // 与 mock 后端 seed 一致：默认项目 id = 服务端 DEFAULT_PROJECT_ID（Web 由 isDefault 字段推导）
  const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
  const select = page.getByTestId("project-select");
  await expect(select).toHaveValue(DEFAULT_PROJECT_ID);

  // 创建额外项目
  await page.getByTestId("new-project").click();
  await page.getByTestId("project-name-input").fill("我的仓库");
  await page.getByTestId("project-cwd-input").fill("/tmp/my-repo");
  await page.getByTestId("project-create-submit").click();
  await expect(select.locator("option", { hasText: "我的仓库" })).toHaveCount(1);

  // 切到额外项目，建一个会话并重命名为唯一标题
  await select.selectOption({ label: "我的仓库" });
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("chat")).toBeVisible();

  const uniqueTitle = `项目会话-${Date.now()}`;
  page.once("dialog", (d) => d.accept(uniqueTitle));
  await page.locator('[data-testid^="rename-"]').first().click();
  await expect(page.getByText(uniqueTitle).first()).toBeVisible();

  // 切回默认项目：不该出现额外项目的会话
  await select.selectOption({ label: "默认项目" });
  await expect(page.getByText(uniqueTitle)).toHaveCount(0);

  // 切回额外项目，删除项目（级联删除其下会话）
  await select.selectOption({ label: "我的仓库" });
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("delete-project").click();
  await expect(select.locator("option", { hasText: "我的仓库" })).toHaveCount(0);
});
