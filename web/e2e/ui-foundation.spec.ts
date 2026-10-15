import { test, expect } from "@playwright/test";
import { appearance } from './focus-appearance';
import { installFoundationFixture, waitForFoundationFixture, setFoundationStyles } from "./ui-foundation.fixture";

test("foundation keyboard, portals, disabled and focus behavior", async ({ page }, testInfo) => {
  const evidence = testInfo.outputPath();
  await page.goto("/visual-fixtures/ui-foundation.html");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.mouse.move(800, 0);
    for (const name of ['Action', 'Menu', 'Open popover']) {
      const target = button(name);
      await target.evaluate(el => (el as HTMLElement).blur());
      const resting = await appearance(target);
      await page.keyboard.press('Tab');
      await target.focus();
      await expect(target).toBeFocused();
    }
  }
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await button("Action").click();
  await expect(page.getByLabel("Selection")).toHaveText("Button");
  await expect(button("Disabled")).toBeDisabled();
  await expect(button("Action")).toHaveAttribute("type", "button");
  await expect(page.getByRole("link", { name: "Anchor" })).toHaveAttribute("href", "#anchor");
  await button("Menu").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "First", exact: true })).toBeFocused();
  await page.mouse.move(800, 0);
  const first = page.getByRole('menuitem', { name: 'First', exact: true });
  const focusedItem = await appearance(first);
  await page.keyboard.press('ArrowDown');
  expect(await appearance(first)).toEqual(focusedItem);
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  await page.screenshot({ path: `${evidence}/dropdown-light.png` });
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemcheckbox")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Checked state")).toHaveText("true");
  await expect(button("Menu")).toBeFocused();
  await button("Open dialog").click();
  await expect(page.getByRole("dialog", { name: "Foundation dialog" })).toBeVisible();
  await expect(page.getByLabel("Value")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(button("Close dialog")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Value")).toBeFocused();
  const lightSurface = await page.getByRole("dialog").evaluate(element => getComputedStyle(element).backgroundColor);
  await page.screenshot({ path: `${evidence}/dialog-light.png` });
  await page.keyboard.press("Escape");
  await expect(button("Open dialog")).toBeFocused();
  await button("Open popover").click();
  await expect(page.getByText("Popover content")).toBeVisible();
  await button("Close popover").click();
  await expect(button("Open popover")).toBeFocused();
  await button("Help").focus();
  await expect(page.getByRole("tooltip")).toHaveText("Accessible hint");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  const darkTokens = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--bg-surface)";
    probe.style.color = "var(--text-primary)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const tokens = { surface: style.backgroundColor, foreground: style.color };
    probe.remove();
    return tokens;
  });
  expect(darkTokens.surface).not.toBe("rgba(0, 0, 0, 0)");
  expect(darkTokens.surface).not.toBe(lightSurface);
  const channels = darkTokens.surface.match(/\d+/g)!.map(Number);
  expect(channels.slice(0, 3).every(channel => channel < 128), "Dark surface must remain dark, not merely inherit a renamed light token").toBe(true);
  await button("Open dialog").click();
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", darkTokens.surface);
  await expect(page.getByRole("dialog")).toHaveCSS("color", darkTokens.foreground);
  await expect(page.getByLabel("Value")).toBeFocused();
  await page.screenshot({ path: `${evidence}/dialog-dark.png` });
  await button("Close dialog").click();
  await expect(button("Open dialog")).toBeFocused();
  await page.screenshot({ path: `${evidence}/foundation-dark.png` });
  await button("Open popover").focus();
  await page.keyboard.press("Enter");
  await expect(button("Close popover")).toBeFocused();
  await expect(page.locator('[data-ui="popover"]')).toHaveCSS("background-color", darkTokens.surface);
  await expect(page.locator('[data-ui="popover"]')).toHaveCSS("color", darkTokens.foreground);
  await expect(page.locator('[data-ui="popover"]')).not.toHaveCSS("box-shadow", "none");
  await page.keyboard.press("Escape");
  await expect(button("Open popover")).toBeFocused();
  await button("Menu").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCSS("background-color", darkTokens.surface);
  await expect(page.getByRole("menu")).toHaveCSS("color", darkTokens.foreground);
  await expect(page.getByRole("menuitem", { name: "First", exact: true })).toBeFocused();
  await page.screenshot({ path: `${evidence}/dropdown-dark.png` });
  await page.keyboard.press("Escape");
  await expect(button("Menu")).toBeFocused();
  await expect(button("Menu")).toHaveCSS("box-shadow", "none");
  await page.setViewportSize({ width: 390, height: 844 });
  await button("Open dialog").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${evidence}/dialog-mobile-dark.png` });
});
// These are paired CSS-isolation checks, not a replacement for the original archived before/after evidence.
// No external baseline is read or updated (including with Playwright --update-snapshots).
for (const history of [false, true]) {
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"] as const) {
      test(`legacy unchanged ${history ? "history" : "empty"} ${width} ${theme}`, async ({ page }, testInfo) => {
        const unexpected = await installFoundationFixture(page, history);
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto("/");
        await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("chat")).toBeVisible();
        await waitForFoundationFixture(page, history, width === 390);
        await page.mouse.move(0, 0);
        await setFoundationStyles(page, false);
        const before = await page.screenshot({ path: testInfo.outputPath("foundation-off.png"), animations: "disabled" });
        await setFoundationStyles(page, true);
        const after = await page.screenshot({ path: testInfo.outputPath("foundation-on.png"), animations: "disabled" });
        await testInfo.attach("foundation-off", { body: before, contentType: "image/png" });
        await testInfo.attach("foundation-on", { body: after, contentType: "image/png" });
        expect(unexpected, "Every API request must be explicitly mocked").toEqual([]);
        expect(after.equals(before), "Foundation CSS must not change legacy UI pixels").toBe(true);
      });
    }
  }
}
