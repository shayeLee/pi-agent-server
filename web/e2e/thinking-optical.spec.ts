import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const samples = {
  english: "review-sample.py modified at 08:50:02 which is when I wrote",
  chinese: "检查文件修改时间并核对思考过程，确认这次修改与记录一致。",
};
for (const dpr of [1, 2]) for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
  test(`thinking optical ${theme} ${touch ? "390" : "desktop"} DPR${dpr}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 1100 }, deviceScaleFactor: dpr, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    await mkdir("/tmp/thinking-optical-align", { recursive: true });
    for (const [language, text] of Object.entries(samples)) {
      await page.goto(`/visual-fixtures/chevrons.html?theme=${theme}&thinking=${encodeURIComponent(text)}`);
      const header = page.locator(".thinking-header");
      const arrow = header.locator(".thinking-chevron");
      await page.mouse.move(0, 0);
      await expect(arrow).toHaveCSS("opacity", touch ? "1" : "0");
      await header.hover();
      await expect(arrow).toHaveCSS("opacity", "1");
      await page.evaluate(() => document.fonts.ready);
      const prefix = `/tmp/thinking-optical-align/${theme}-${touch ? "390" : "desktop"}-dpr${dpr}-${language}`;
      await header.screenshot({ path: `${prefix}-hover.png` });
      const metrics = await header.evaluate(el => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        const glyphs = [".thinking-label"].map(selector => {
          const span = el.querySelector(selector)!;
          const style = getComputedStyle(span);
          const marker = document.createElement("i");
          marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
          span.append(marker);
          const baseline = marker.getBoundingClientRect().top;
          marker.remove();
          ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const ink = ctx.measureText(span.textContent!);
          const rect = span.getBoundingClientRect();
          return { selector, font: ctx.font, lineHeight: style.lineHeight, baseline, boxCenter: rect.y + rect.height / 2, inkCenter: baseline + (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2 };
        });
        const svg = el.querySelector("svg")!;
        const rect = svg.getBoundingClientRect();
        const path = svg.querySelector("path")!;
        const bounds = path.getBBox();
        const matrix = path.getScreenCTM()!;
        const point = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(matrix);
        const before = (svg.previousElementSibling ?? el.querySelector(".thinking-label"))!.getBoundingClientRect();
        return { glyphs, arrow: { width: rect.width, height: rect.height, center: point.y, path: path.getAttribute("d"), gap: rect.left - before.right }, display: getComputedStyle(svg).display };
      });
      await writeFile(`${prefix}-metrics.json`, JSON.stringify(metrics, null, 2));
      expect(metrics.arrow.width).toBe(12);
      expect(metrics.arrow.height).toBe(12);
      expect(metrics.arrow.gap).toBe(8);
      expect(metrics.display).toBe("block");
      // Compare actual glyph ink, not just the flex-item rectangles.
      for (const glyph of metrics.glyphs) expect(Math.abs(metrics.arrow.center - glyph.inkCenter)).toBeLessThanOrEqual(0.75);
      await expect(header.locator(".thinking-summary")).toBeVisible();
      expect((await header.locator(".thinking-summary").textContent())?.trim().length).toBeGreaterThan(0);
      expect(metrics.glyphs.map(glyph => glyph.lineHeight)).toEqual(["18px"]);
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".thinking-body")).toHaveText(text);
      await page.mouse.move(0, 0);
      await expect(arrow).toHaveCSS("opacity", touch ? "1" : "0");
      if (!touch) {
        await page.locator("#start").focus();
        for (let i = 0; i < 40 && !await header.evaluate(el => el === document.activeElement); i++) await page.keyboard.press("Tab");
        await expect(header).toBeFocused();
        await expect(arrow).toHaveCSS("opacity", "1");
      }
      await header.screenshot({ path: `${prefix}-expanded.png` });
      await page.screenshot({ path: `${prefix}-final.png`, fullPage: true });
    }
    await context.close();
  });
}
