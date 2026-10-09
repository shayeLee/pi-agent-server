import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
  test(`tool status ${theme} ${touch ? "touch" : "desktop"}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    await page.goto(`/visual-fixtures/tool-status.html?theme=${theme}`);
    await mkdir("/tmp/tool-icons-always/status", { recursive: true });
    const prefix = `/tmp/tool-icons-always/status/${theme}-${touch ? "touch" : "desktop"}`;
    await page.mouse.move(0, 0);
    await expect(page.locator(".tool-status-icon")).toHaveCount(3);
    await expect(page.locator(".tool-status-pending,.tool-status-waiting")).toHaveCount(0);
    await page.screenshot({ path: `${prefix}-default.png`, fullPage: true });
    for (const id of ["success", "error", "unfinished"]) {
      const card = page.locator(`[data-tool-call-id="${id}"]`);
      const header = card.locator(".tool-call-header");
      const icon = header.locator(".tool-status-icon");
      await expect(card.locator('.tool-toggle')).toHaveCSS('opacity', '1');
      await expect(card.locator('.tool-more-trigger')).toHaveCSS('opacity', '1');
      // Rotation changes the SVG's axis-aligned bounding box, not its layout slot or center.
      const geometry = () => icon.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const parent = el.parentElement!.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          parent: { x: parent.x, y: parent.y, width: parent.width, height: parent.height },
          centerX: Math.round((rect.x + rect.width / 2) * 1000) / 1000,
          centerY: Math.round((rect.y + rect.height / 2) * 1000) / 1000,
          width: style.width, height: style.height,
        };
      });
      const before = await geometry();
      expect(before.width).toBe("14px");
      expect(before.height).toBe("14px");
      await expect(header).toHaveAttribute("aria-expanded", String(id === "unfinished"));
      await expect(icon).toHaveCSS("opacity", "1");
      await expect(icon.locator("title")).toHaveText(id === "unfinished" ? "进行中" : id === "error" ? "失败" : "已完成");
      if (!touch) {
        await header.hover();
        await expect(icon).toHaveCSS("opacity", "1");
        expect(await geometry()).toEqual(before);
        await page.screenshot({ path: `${prefix}-${id}-hover.png`, fullPage: true });
        await header.click();
        const expandedGeometry = await geometry(); // Existing expansion removes the single-line preview.
        await page.mouse.move(0, 0);
        await expect(header).toBeFocused();
        expect(await header.evaluate(el => el.matches(":focus-visible"))).toBe(false);
        await expect(icon).toHaveCSS("opacity", "1");
        expect(await geometry()).toEqual(expandedGeometry);
        await expect(header).toHaveCSS("outline-style", "none");
        await page.screenshot({ path: `${prefix}-${id}-mouse-out.png`, fullPage: true });
        await page.locator("#start").click();
        for (let tabs = 0; tabs < 30; tabs++) {
          await page.keyboard.press("Tab");
          if (await header.evaluate(el => el === document.activeElement)) break;
        }
        await expect(header).toBeFocused();
        expect(await header.evaluate(el => el.matches(":focus-visible"))).toBe(true);
        await expect(icon).toHaveCSS("opacity", "1");
        expect(await geometry()).toEqual(expandedGeometry);
        await page.screenshot({ path: `${prefix}-${id}-tab.png`, fullPage: true });
      } else {
        await header.tap();
        const expandedGeometry = await geometry();
        await page.mouse.move(0, 0);
        await expect(icon).toHaveCSS("opacity", "1");
        expect(await geometry()).toEqual(expandedGeometry);
        await page.screenshot({ path: `${prefix}-${id}-touch.png`, fullPage: true });
      }
      await header.click(); // Restore initial visibility without changing lifecycle.
      await page.locator("#start").click();
      await page.mouse.move(0, 0);
    }
    await context.close();
  });
}
