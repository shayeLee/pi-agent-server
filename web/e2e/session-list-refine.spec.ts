import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const width of [1280, 390]) for (const theme of ["light", "dark"] as const) {
  test(`session sidebar ${width} ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme, hasTouch: width === 390, reducedMotion: "reduce" });
    const page = await context.newPage();
    const titles = ["Hi", "修复会话列表布局：让完整标题优先、共享图标紧邻时间", "/var/folders/xn/session-sidebar-review/very-long-session-title", "共享工作记录", "test", "检查键盘导航和导出行为"];
    let sessions = titles.map((title, i) => ({ id: `s${i}`, title, ownerKey: "fixture", projectId: "p", createdAt: 1, updatedAt: Date.now() - [1000, 57600000, 2073600000, 3456000000, 63072000000, 600000][i]!, visibility: i % 2 ? "shared" : "private", modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null }));
    const exports: string[] = [];
    await context.route("**/v1/**", async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let body: unknown;
      if (path === "/v1/projects") body = [{ id: "p", name: "默认项目", cwd: "/tmp/session-list-fixture", isDefault: true }];
      else if (path === "/v1/access") body = { canRead: true, canWrite: true, canAdmin: false };
      else if (path === "/v1/models") body = { models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" };
      else if (path === "/v1/sessions") body = sessions;
      else if (path.endsWith("/export")) {
        exports.push(path);
        body = { session: sessions.find(s => path.includes(`/${s.id}/`)), messages: [], timeline: [] };
      } else if (route.request().method() === "PATCH") {
        const s = sessions.find(s => path.endsWith(`/${s.id}`))!;
        Object.assign(s, route.request().postDataJSON()); body = s;
      } else if (route.request().method() === "DELETE") {
        sessions = sessions.filter(s => !path.endsWith(`/${s.id}`)); body = {};
      } else if (path.endsWith("/events")) {
        await route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }); return;
      } else { await route.abort(); return; }
      await route.fulfill({ json: body });
    });
    await page.goto("/");
    const sidebar = page.getByTestId("sidebar");
    const open = async () => { if (width === 390 && !(await sidebar.isVisible())) await page.getByRole("button", { name: "打开工作区导航" }).click(); };
    await open();
    await expect(page.getByTestId("session-s1")).toBeVisible();
    await page.getByTestId("session-s1").click();
    await open();
    const selected = page.getByTestId("session-s1");
    await expect(selected).toHaveAttribute("aria-current", "true");
    await expect(selected).toHaveAccessibleName(titles[1]!);
    await expect(selected.locator(".session-title")).toHaveAttribute("title", titles[1]!);
    for (const row of await page.locator(".session-item").all()) {
      const select = await row.locator(".session-select").boundingBox();
      const actions = await row.locator(".session-actions").boundingBox();
      expect(select!.y + select!.height).toBeLessThanOrEqual(actions!.y + 1);
      const box = await row.boundingBox();
      expect(select!.width).toBeCloseTo(box!.width, 0);
      const badge = row.locator(".session-shared-badge");
      if (await badge.count()) {
        const time = await row.locator("time").boundingBox(); const icon = await badge.boundingBox();
        expect(icon!.x - time!.x - time!.width).toBeCloseTo(6, 0);
        expect(Math.abs(icon!.y + icon!.height / 2 - time!.y - time!.height / 2)).toBeLessThan(1);
      }
    }
    await mkdir("/tmp/session-list-refine", { recursive: true });
    await page.mouse.move(900, 800);
    await selected.blur();
    await page.screenshot({ path: `/tmp/session-list-refine/${width}-${theme}-selected.png` });
    const restingBox = await selected.boundingBox();
    const restingBackground = await selected.locator("..").evaluate(el => getComputedStyle(el).backgroundColor);
    await selected.hover();
    expect(await selected.boundingBox()).toEqual(restingBox);
    expect(await selected.locator("..").evaluate(el => getComputedStyle(el).backgroundColor)).toBe(restingBackground);
    await expect(selected.locator("..").locator(".session-actions")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `/tmp/session-list-refine/${width}-${theme}-hover.png` });
    await selected.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("rename-s1")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(selected.locator(".session-title")).toHaveCSS("text-decoration-line", "underline");
    await expect(selected).toHaveCSS("outline-style", "none");
    await expect(selected).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(await selected.boundingBox()).toEqual(restingBox);
    await page.screenshot({ path: `/tmp/session-list-refine/${width}-${theme}-keyboard.png` });
    if (width === 390) for (const b of await page.locator(".session-actions button").all()) {
      const box = await b.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    // Separate action hit targets must not select another session.
    page.once("dialog", dialog => dialog.accept("已重命名"));
    await page.getByTestId("rename-s3").click();
    await expect(page.getByTestId("session-s3")).toHaveAccessibleName("已重命名");
    await expect(selected).toHaveAttribute("aria-current", "true");
    const count = exports.length;
    await page.getByTestId("export-s3").click();
    await expect.poll(() => exports.length).toBeGreaterThan(count);
    await expect(selected).toHaveAttribute("aria-current", "true");
    page.once("dialog", dialog => dialog.accept());
    await page.getByTestId("delete-s3").click();
    await expect(page.getByTestId("session-s3")).toHaveCount(0);
    await expect(selected).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "搜索会话", exact: true }).click();
    await page.getByTestId("session-search").fill("不存在的会话");
    await expect(page.getByTestId("empty-sessions")).toBeVisible();
    await context.close();
  });
}
