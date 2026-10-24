import { expect, request, test, type Page } from "@playwright/test";
import { ACCOUNTS } from "./accounts.fixture";

// Accounts mode against the real auth routes (mock agent only). docs/login-design.md §13: log in,
// a refresh keeps the login, log out, a 401 returns to the login page, and another account never
// gets the previous one's drafts or sessions.

async function logIn(page: Page, name: string, password: string) {
  await page.getByTestId("login-name").fill(name);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-page")).toBeHidden();
  await expect(page.getByTestId("new-session")).toBeVisible();
}

async function logOut(page: Page) {
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login-page")).toBeVisible();
}

async function startSession(page: Page, prompt: string) {
  await page.getByTestId("new-session").click();
  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("message-list")).toContainText("你好，我是 pi-agent-server 测试助手");
}

test("logs in, keeps the login across a refresh, and logs out", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("login-page")).toBeVisible();
  await expect(page.getByTestId("login-origin-hint")).toHaveCount(0);

  await page.getByTestId("login-name").fill(ACCOUNTS.mz.name);
  await page.getByTestId("login-password").fill("not the password");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-error")).toHaveText("账号或密码错误");
  // One failure backs this IP off for a second; an immediate retry is refused with that wait.
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-error")).toHaveText(/尝试太频繁，请 \d+ 秒后再试/);
  await page.waitForTimeout(1_100);

  await page.getByTestId("login-password").fill(ACCOUNTS.mz.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("new-session")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("new-session")).toBeVisible();
  await expect(page.getByTestId("login-page")).toHaveCount(0);
  await page.getByTestId("settings-toggle").click();
  await expect(page.getByTestId("account-name")).toHaveText(`账号 ${ACCOUNTS.mz.name}`);
  await page.keyboard.press("Escape");

  await logOut(page);
  await expect(page.getByTestId("login-notice")).toHaveText("已退出登录。");
  await page.reload();
  await expect(page.getByTestId("login-page")).toBeVisible();
  expect((await page.context().cookies()).filter(cookie => cookie.name === "pi_session_5231")).toEqual([]);
});

test("another account does not get the previous account's draft or sessions", async ({ page }) => {
  await page.goto("/");
  await logIn(page, ACCOUNTS.mz.name, ACCOUNTS.mz.password);
  await startSession(page, "mz 的私有会话");
  await page.getByTestId("composer-input").fill("mz 还没发的草稿");
  await logOut(page);

  await logIn(page, ACCOUNTS.ada.name, ACCOUNTS.ada.password);
  await expect(page.getByTestId("sidebar")).not.toContainText("mz 的私有会话");
  await expect(page.getByTestId("composer-input")).toHaveValue("");
  // The address may still point at mz's session; ada does not see it.
  await expect(page.getByTestId("message-list")).toHaveCount(0);
});

test("a login ended elsewhere returns to the login page; signing back in keeps the draft", async ({ page, baseURL }) => {
  await page.goto("/");
  await logIn(page, ACCOUNTS.kim.name, ACCOUNTS.kim.password);
  await startSession(page, "kim 的会话");
  await page.getByTestId("composer-input").fill("kim 写了一半");

  // Another device of kim changes the password: every other login of kim ends.
  const other = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL! } });
  const next = "kim-e2e-password-2";
  try {
    expect((await other.post("/v1/auth/login", { data: { name: ACCOUNTS.kim.name, password: ACCOUNTS.kim.password } })).status()).toBe(200);
    expect((await other.put("/v1/auth/password", { data: { current: ACCOUNTS.kim.password, next } })).status()).toBe(204);
  } finally {
    await other.dispose();
  }

  // The open event stream rechecks the login and ends; the page asks to log in again.
  await expect(page.getByTestId("login-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("login-notice")).toHaveText("登录已失效，请重新登录。");

  await logIn(page, ACCOUNTS.kim.name, next);
  await expect(page.getByTestId("composer-input")).toHaveValue("kim 写了一半");
  await expect(page.getByTestId("message-list")).toContainText("kim 的会话");
});
