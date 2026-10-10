import { test, expect } from "@playwright/test";

for (const width of [1280, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`theme follows system until manually overridden: ${width}px / system ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      // Theme switching must not depend on accessible browser storage.
      await page.addInitScript(() => {
        for (const key of ["localStorage", "sessionStorage"]) {
          Object.defineProperty(window, key, { configurable: true, get() {
            throw new DOMException("Fixture: storage unavailable", "SecurityError");
          } });
        }
      });
      await page.goto("/");
      const app = page.getByTestId("app");
      const toggle = page.getByTestId("theme-toggle");
      const opposite = colorScheme === "dark" ? "light" : "dark";
      const values = {
        dark: { aria: "切换为亮色主题", icon: "sun", background: "rgb(0, 0, 0)" },
        light: { aria: "切换为暗色主题", icon: "moon", background: "rgb(255, 255, 255)" },
      } as const;
      const backgrounds = () => page.evaluate(() => [
        document.querySelector('[data-testid="app"]')!,
        document.querySelector('[data-testid="chat"]')!,
        document.body,
      ].map((element) => getComputedStyle(element).backgroundColor));
      const expectTheme = async (theme: "dark" | "light") => {
        await expect(app).toHaveAttribute("data-theme", theme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(toggle).toHaveAttribute("aria-label", values[theme].aria);
        await expect(toggle.locator("svg")).toHaveAttribute("data-icon", values[theme].icon);
        await expect(toggle.locator("svg")).toHaveAttribute("aria-hidden", "true");
        await expect.poll(backgrounds).toEqual(Array(3).fill(values[theme].background));
      };

      if (width === 390) {
        await page.getByRole("button", { name: "打开工作区导航" }).click();
        await expect(page.getByTestId("sidebar")).toBeVisible();
      }
      await expectTheme(colorScheme);

      // Before a manual choice, a system preference change updates the active theme.
      await page.emulateMedia({ colorScheme: opposite });
      await expectTheme(opposite);
      // Manual clicks work in both directions and prevent further system changes overriding them.
      await toggle.click();
      await expectTheme(colorScheme);
      await page.emulateMedia({ colorScheme });
      await expectTheme(colorScheme);
      await toggle.click();
      await expectTheme(opposite);

      // Override is page-local: reloading follows the current system preference again.
      await page.reload();
      await expectTheme(colorScheme);
    });
  }
}
