import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
  test(`all chevrons: ${theme} / ${touch ? "touch" : "desktop"}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 1100 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    await page.goto(`/visual-fixtures/chevrons.html?theme=${theme}`);
    // Raw data uses a modal, not a disclosure chevron.
    await page.locator("#start").click();
    const arrows = page.locator(".disclosure-chevron");
    await expect(arrows).toHaveCount(7);
    await mkdir("/tmp/all-chevron-align", { recursive: true });
    const prefix = `/tmp/all-chevron-align/${theme}-${touch ? "touch" : "desktop"}`;
    await page.mouse.move(0, 0);
    const activeSession = page.locator(".session-item.active");
    const activeBackground = theme === "dark" ? "rgb(35, 44, 59)" : "rgb(233, 238, 251)";
    await expect(activeSession).toHaveCSS("background-color", activeBackground);
    await page.screenshot({ path: `${prefix}-default.png`, fullPage: true });
    // Never index the live SVG collection: collapsing a tool unmounts its raw-data controls.
    const cases = [
      ["project", page.getByTestId("project-select")],
      ["thinking", page.locator(".thinking-header")],
      ["tool", page.locator(".tool-call-header")],
      ["model", page.getByTestId("model-thinking-trigger")],
      ["menu", page.getByRole("button", { name: "普通菜单", exact: true })],
      ["native-select", page.locator(".event-log .icon-select")],
      ["event", page.getByTestId("event-1").locator("summary")],
    ] as const;
    expect(cases).toHaveLength(7);
    for (const [kind, trigger] of cases) {
      await expect(trigger).toHaveCount(1);
      const arrow = trigger.locator(kind === "tool" ? ".tool-toggle" : ":scope > .disclosure-chevron");
      await expect(arrow).toHaveCount(1);
      const control = trigger.locator("select");
      const nativeSelect = await control.count() > 0;
      const expanded = await trigger.getAttribute("aria-expanded");
      const details = trigger.locator("xpath=parent::details");
      const detailsOpen = await details.count() ? await details.evaluate(el => el.hasAttribute("open")) : null;
      const geometry = async () => arrow.evaluate(el => {
        const a = el.getBoundingClientRect();
        const p = el.parentElement!;
        const label = p.matches(".icon-select,.model-thinking-trigger") ? p : el.previousElementSibling!;
        const b = label.getBoundingClientRect();
        return { x: a.x, y: a.y, width: a.width, height: a.height, delta: Math.abs(a.y + a.height / 2 - b.y - b.height / 2), display: getComputedStyle(el).display };
      });
      const before = await geometry();
      expect(before.width).toBe(12); expect(before.height).toBe(12);
      expect(before.display).toBe("block"); expect(before.delta).toBeLessThanOrEqual(1);
      await expect(arrow).toHaveCSS("opacity", touch || kind === "tool" ? "1" : "0");
      if (!touch) {
        await trigger.hover();
        await expect(arrow).toHaveCSS("opacity", "1");
        expect(await geometry()).toEqual(before);
        await page.screenshot({ path: `${prefix}-hover-${kind}.png`, fullPage: true });
        // Native select keyboard modality is tested only via real Tab below.
        if (!nativeSelect) {
          // Start closed so this is an actual mouse expansion, not just a collapse.
          if (expanded === "true" || detailsOpen) await trigger.click();
          await trigger.click();
          if (expanded !== null) await expect(trigger).toHaveAttribute("aria-expanded", "true");
          if (detailsOpen !== null) await expect(details).toHaveAttribute("open", "");
          const listbox = page.getByRole("listbox");
          const transfersFocus = await trigger.getAttribute("aria-haspopup") === "listbox";
          await expect(transfersFocus ? listbox : trigger).toBeFocused();
          await page.mouse.move(0, 0);
          await expect(arrow).toHaveCSS("opacity", kind === "tool" ? "1" : "0");
          await expect(transfersFocus ? listbox : trigger).toBeFocused();
          if (kind === "project") {
            await expect(trigger).toHaveCSS("outline-style", "none");
            await expect(trigger).toHaveCSS("box-shadow", "none");
          }
          expect((await geometry()).delta).toBeLessThanOrEqual(1);
          await page.screenshot({ path: `${prefix}-mouse-open-${kind}.png`, fullPage: true });
          if (await trigger.getAttribute("aria-haspopup")) await page.keyboard.press("Escape");
        }
        // Tab to each actual native interaction, not programmatic focus-visible simulation.
        await page.locator("#start").focus();
        let reached = false;
        for (let tabs = 0; tabs < 40; tabs++) {
          await page.keyboard.press("Tab");
          reached = await trigger.evaluate(el => el === document.activeElement || el.contains(document.activeElement));
          if (reached) break;
        }
        expect(reached).toBe(true);
        await expect(nativeSelect ? control : trigger).toBeFocused();
        expect(await (nativeSelect ? control : trigger).evaluate(el => el.matches(":focus-visible"))).toBe(true);
        await expect(arrow).toHaveCSS("opacity", "1");
        expect((await geometry()).delta).toBeLessThanOrEqual(1);
        await page.screenshot({ path: `${prefix}-keyboard-${kind}.png`, fullPage: true });
        await page.locator("#start").click();
      } else {
        if (!nativeSelect) {
          if (expanded === "true" || detailsOpen) await trigger.tap();
          await trigger.tap();
          if (expanded !== null) await expect(trigger).toHaveAttribute("aria-expanded", "true");
          if (detailsOpen !== null) await expect(details).toHaveAttribute("open", "");
        }
        await expect(arrow).toHaveCSS("opacity", "1");
        expect((await geometry()).delta).toBeLessThanOrEqual(1);
        await page.screenshot({ path: `${prefix}-touch-open-${kind}.png`, fullPage: true });
        if (await trigger.getAttribute("aria-haspopup")) await page.keyboard.press("Escape");
      }
      // Restore each disclosure before checking the remaining arrows.
      if (expanded !== null && await trigger.getAttribute("aria-expanded") !== expanded) await trigger.click();
      if (detailsOpen !== null && await details.evaluate(el => el.hasAttribute("open")) !== detailsOpen) await trigger.click();
      await page.locator("#start").click();
      await page.mouse.move(0, 0);
      await expect(arrows).toHaveCount(7);
    }
    for (const button of await page.locator(".sidebar :is(.project-switcher,.session-list) button").all()) {
      await page.locator("#start").focus();
      for (let tabs = 0; tabs < 40; tabs++) {
        await page.keyboard.press("Tab");
        if (await button.evaluate(el => el === document.activeElement)) break;
      }
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-style", "none");
      await expect(button).toHaveCSS("box-shadow", "none");
      await expect(button).toHaveCSS("background-color", theme === "dark" ? "rgb(50, 47, 43)" : "rgb(237, 234, 229)");
      await expect(activeSession).toHaveCSS("background-color", activeBackground);
    }
    await page.getByTestId("session-s").click();
    await page.mouse.move(0, 0);
    await expect(page.getByTestId("session-s")).toBeFocused();
    await expect(page.getByTestId("session-s")).toHaveCSS("outline-style", "none");
    await expect(page.getByTestId("session-s")).toHaveCSS("box-shadow", "none");
    await expect(activeSession).toHaveCSS("background-color", activeBackground);
    await page.screenshot({ path: `${prefix}-final.png`, fullPage: true });
    await context.close();
  });
}
