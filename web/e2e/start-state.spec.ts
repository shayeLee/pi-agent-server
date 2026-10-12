import { test, expect } from "@playwright/test";

// Isolated visual check of the start state, new-session settings and the narrow-screen drawer.
// Runs only against the local mock with MOCK_SCENARIO=rich; never points at a live service.
test.skip(process.env.MOCK_SCENARIO !== "rich", "Requires the isolated rich mock scenario");

const modelsRoute = async (page: import("@playwright/test").Page) => {
  await page.route("**/v1/models", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      models: [{ provider: "fixture", id: "crossband/very-long-model-id-for-visual-qa", name: "Local visual model" }],
      defaultModel: { provider: "fixture", id: "crossband/very-long-model-id-for-visual-qa", name: "Local visual model" },
      thinkingLevels: ["off", "medium"], defaultThinkingLevel: "medium",
    }),
  }));
};

// Keep shots together within one run; archive them before another Playwright suite clears test-results.
const shot = (_: unknown, name: string) => `test-results/start-shots/${name}`;

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`起始态与导航：${theme} / ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      await modelsRoute(page);
      await page.goto("/");
      await expect(page.getByTestId("new-session")).toBeAttached();
      if (width === 390) {
        // 窄屏抽屉初始关闭；主题开关位于名录内，需先打开抽屉才能切换。
        await expect(page.getByTestId("sidebar")).toBeHidden();
        await page.getByRole("button", { name: "打开工作区导航" }).click();
        await expect(page.getByTestId("sidebar")).toBeVisible();
      }
      await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);
      if (width === 390) {
        // 抽屉截图必须在主题确定之后，否则图片与命名不符。
        await page.screenshot({ path: shot(testInfo, `drawer-${theme}-${width}.png`), animations: "disabled" });
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("sidebar")).toBeHidden();
        await page.getByTestId("composer-input").click();
      }

      // 起始态：没有会话、没有伪造历史。
      await expect(page.getByTestId("no-session-hint")).toBeVisible();
      await expect(page.getByTestId("model-thinking-trigger")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
      await page.screenshot({ path: shot(testInfo, `start-${theme}-${width}.png`), animations: "disabled" });

      // 新会话设置浮层：完整模型 ID 可达，且不与附件按钮重叠。
      await page.getByTestId("model-thinking-trigger").click();
      await expect(page.getByTestId("model-thinking-model-option").first()).toContainText("crossband/very-long-model-id-for-visual-qa");
      await page.screenshot({ path: shot(testInfo, `start-model-${theme}-${width}.png`), animations: "disabled" });
      await page.getByTestId("model-thinking-trigger").click();

      const plus = await page.getByRole("button", { name: "添加附件" }).boundingBox();
      const trigger = await page.getByTestId("model-thinking-trigger").boundingBox();
      const send = await page.getByTestId("send-button").boundingBox();
      const overlaps = (a: typeof plus, b: typeof plus) =>
        !!a && !!b && a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
      expect(plus && trigger && send).toBeTruthy();
      expect(overlaps(plus, trigger)).toBe(false);
      expect(overlaps(trigger, send)).toBe(false);
      expect(trigger!.x + trigger!.width).toBeLessThanOrEqual(width + 1);
      expect(trigger!.x).toBeGreaterThanOrEqual(0);

      if (width === 390) {
        await page.getByTestId("composer-input").fill("起始态视觉检查");
        await page.screenshot({ path: shot(testInfo, `start-typing-${theme}-${width}.png`), animations: "disabled" });
      }
    });
  }
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1235, height: 390 },
  { width: 390, height: 844 },
]) {
  test(`模型与思考深度浮层：${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const models = Array.from({ length: 28 }, (_, index) => ({
      provider: `fixture-${index % 3}`,
      id: `model-${String(index).padStart(2, "0")}-long-provider-model-id`,
      name: `Fixture Model ${index}`,
    }));
    await page.route("**/v1/models", async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models,
        defaultModel: models[0],
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        defaultThinkingLevel: "medium",
      }),
    }));
    await page.goto("/");
    await expect(page.getByTestId("model-thinking-trigger")).toBeVisible();
    await page.getByTestId("model-thinking-trigger").click();

    const panel = page.getByRole("dialog", { name: "模型与思考深度" });
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox).toBeTruthy();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.y).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await panel.evaluate((element) => getComputedStyle(element).overflowY)).toBe("hidden");

    const thoughtRadios = page.getByTestId("model-thinking-level-option");
    await expect(thoughtRadios).toHaveCount(6);
    const thoughtGroup = page.locator(".model-thinking-level-options");
    expect(await thoughtGroup.evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    expect(await thoughtGroup.evaluate((element) => element.scrollHeight === element.clientHeight)).toBe(true);
    await expect(page.getByRole("radio", { name: "medium" })).toHaveAttribute("aria-checked", "true");
    for (let index = 0; index < 6; index += 1) {
      const box = await thoughtRadios.nth(index).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.y).toBeGreaterThanOrEqual(panelBox!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.screenshot({ path: `/tmp/reading-first-picker/model-thinking-${viewport.width}x${viewport.height}.png` });

    const scrollY = await page.evaluate(() => window.scrollY);
    await page.getByRole("radio", { name: "medium" }).click();
    await page.getByRole("radio", { name: "xhigh" }).click();
    await expect(page.getByTestId("thinking-trigger")).toHaveText("xhigh");
    await expect(page.getByTestId("model-thinking-trigger")).toHaveAccessibleName(/思考深度：xhigh/);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

    const modelOptions = page.locator(".model-thinking-model-options");
    expect(await modelOptions.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    expect(await modelOptions.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await modelOptions.evaluate((element) => { element.scrollTop = 160; });
    expect(await modelOptions.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const search = page.getByRole("searchbox", { name: "搜索模型" });
    await search.fill("model-27-long-provider-model-id");
    const lastModel = page.getByRole("radio", { name: "fixture-0/model-27-long-provider-model-id (Fixture Model 27)" });
    await expect(lastModel).toBeVisible();
    await lastModel.click();
    await expect(page.getByTestId("model-thinking-trigger")).toContainText("model-27-long-provider-model-id");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  });
}
