import { expect, type Page } from "@playwright/test";
import { isOptionalFeature, notFound } from "./optional-features";
import { failOnUnexpectedRequest } from "./unexpected-request";

export const historyText = "历史会话用于验证 foundation 不影响现有消息布局。";
const projectId = "foundation-project";
const sessionId = "foundation-history";

// No backend, user data, persisted selection or streaming timers participate in these screenshots.
export async function installFoundationFixture(page: Page, history: boolean) {
  const unexpected: string[] = [];
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.route("**/v1/**", async route => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (isOptionalFeature(pathname)) return route.fulfill(notFound);
    if (route.request().method() === "GET") {
      if (pathname === "/v1/access") return json({ canRead: true, canWrite: true });
      if (pathname === "/v1/projects") return json([{ id: projectId, name: "默认项目", cwd: "/fixture", isDefault: true }]);
      if (pathname === "/v1/models") return json({ models: [{ provider: "fixture", id: "fixture-model", name: "Fixture model" }],
        defaultModel: { provider: "fixture", id: "fixture-model", name: "Fixture model" }, thinkingLevels: ["off"], defaultThinkingLevel: "off" });
      if (pathname === "/v1/sessions") return json(history ? [{ id: sessionId, projectId, title: "Foundation 历史会话", createdAt: 1700000000000,
        updatedAt: 1700000000000, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null }] : []);
      if (pathname === `/v1/sessions/${sessionId}/export`) return json({ messages: [], lastEventId: 0, timeline: [
        { type: "message", id: "foundation-user", role: "user", text: historyText },
        { type: "message", id: "foundation-assistant", role: "assistant", text: "## 回归检查\n\n保留 **消息排版**、侧栏和输入框。\n\n- 桌面和移动端\n- 亮色和暗色主题" },
      ] });
      if (pathname === `/v1/sessions/${sessionId}/control-queue`) return json({ requestId: null, revision: 0, items: [] });
      if (pathname === `/v1/sessions/${sessionId}/subagents`) return json({ sessionId, runs: [] });
      if (pathname === `/v1/sessions/${sessionId}/events`) return route.fulfill({ status: 204, body: "" });
    }
    await failOnUnexpectedRequest(page, route, unexpected);
  });
  return unexpected;
}

export async function waitForFoundationFixture(page: Page, history: boolean, mobile: boolean) {
  // Even on mobile, explicitly observe completed sidebar loading rather than screenshot a hidden pending list.
  if (mobile) await page.getByRole("button", { name: "打开工作区导航" }).click();
  if (history) {
    const session = page.getByTestId(`session-${sessionId}`);
    await expect(session).toBeVisible();
    await session.click();
    await expect(page.getByTestId("message-list")).toContainText(historyText);
    await expect(page.getByTestId("message-list")).toContainText("回归检查");
  } else {
    await expect(page.getByTestId("empty-sessions")).toBeVisible();
    if (mobile) await page.keyboard.press("Escape");
  }
  if (mobile) await expect(page.getByTestId("sidebar")).toBeHidden();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByText("加载中…", { exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

export async function setFoundationStyles(page: Page, enabled: boolean) {
  // Vite owns this style element. Fail if the foundation sheet is missing/renamed, never compare two no-op screenshots.
  const sheet = page.locator('style[data-vite-dev-id$="/src/styles/ui.css"]');
  await expect(sheet).toHaveCount(1);
  await sheet.evaluate((element, on) => {
    const style = element as HTMLStyleElement;
    if (!style.sheet) throw new Error("Foundation stylesheet not loaded");
    style.sheet.disabled = !on;
  }, enabled);
  expect(await sheet.evaluate(element => (element as HTMLStyleElement).sheet!.disabled)).toBe(!enabled);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}
