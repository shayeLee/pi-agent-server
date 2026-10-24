import { expect, test } from "@playwright/test";

// docs/companion-butler.md §12.6: "运行动态" opens a right-hand panel — the run lists, then the
// butler conversation — that takes the trace's place. This mock makes 127.0.0.1 an admin.

test("the butler answers in the panel, a reset starts over, and the panel and the trace close each other", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("composer-input").fill("先开一个普通会话");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant")).toHaveCount(1);

  await page.getByTestId("sidebar-activity-toggle").click();
  const panel = page.getByTestId("butler-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await expect(page.getByTestId("butler-conversation")).toBeVisible();
  await expect(page.getByTestId("butler-reset")).toHaveCount(0);
  // Its header line follows the chat header's, like the trace's, also when the header grows.
  const bottom = (selector: string) => page.locator(selector).evaluate(el => el.getBoundingClientRect().bottom);
  await page.getByTestId("chat-header").evaluate(el => { el.style.minHeight = `${el.getBoundingClientRect().height + 20}px`; });
  await expect.poll(async () => await bottom(".butler-head") - await bottom('[data-testid="chat-header"]')).toBe(0);
  await page.getByTestId("chat-header").evaluate(el => { el.style.minHeight = ""; });

  await page.getByTestId("butler-input").fill("现在有什么在跑？");
  await page.getByTestId("butler-send").click();
  await expect(panel.locator(".message-user")).toContainText("现在有什么在跑？");
  await expect(panel.locator(".message-assistant")).toContainText("测试助手");
  await expect(page.getByTestId("butler-input")).toHaveValue("");
  // The butler's own session stays out of the sidebar.
  await expect(page.locator("li.session-item")).toHaveCount(1);

  // Closed and reopened, it reloads the same conversation from the server (the mock keeps no
  // history, so this checks the request; the real-model check covers what comes back).
  await page.getByTestId("butler-close").click();
  await expect(panel).toHaveCount(0);
  const reload = page.waitForResponse(response => /\/v1\/sessions\/[^/]+\/export$/.test(new URL(response.url()).pathname));
  await page.getByTestId("sidebar-activity-toggle").click();
  expect((await reload).ok()).toBeTruthy();
  await expect(page.getByTestId("butler-reset")).toBeVisible();

  const fresh = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/butler");
  await page.getByTestId("butler-reset").click();
  expect(await (await fresh).request().postDataJSON()).toEqual({ reset: true });
  await expect(panel.locator(".message-assistant")).toHaveCount(0);
  await expect(panel.locator(".butler-empty")).toBeVisible();

  // The trace takes the column back, and the butler gives it up again.
  await page.getByTestId("trace-tab").click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("sidebar-activity-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("sidebar-activity-toggle").click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("inspector")).toHaveCount(0);
});
