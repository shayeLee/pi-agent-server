import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const outputDir = "/tmp/session-search-align";

for (const width of [1280, 390]) {
  for (const theme of ["dark", "light"] as const) {
    test(`会话历史标题与搜索按钮对齐：${theme} / ${width}px`, async ({ page }) => {
      await mkdir(outputDir, { recursive: true });
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/");
      await expect(page.getByTestId("session-list")).toBeAttached();

      if (width === 390) {
        await page.getByRole("button", { name: "打开工作区导航" }).click();
        await expect(page.getByTestId("sidebar")).toBeVisible();
      }
      await expect(page.getByTestId("session-list")).toBeVisible();
      if (await page.getByTestId("app").getAttribute("data-theme") !== theme) {
        await page.getByTestId("theme-toggle").click();
      }
      await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);

      const projectTitle = page.locator(".workbench-section-header").first();
      const sessionTitle = page.locator(".session-list-header > span");
      const addProject = page.getByTestId("new-project");
      const search = page.getByRole("button", { name: "搜索会话" });
      const projectTitleBox = await projectTitle.boundingBox();
      const sessionTitleBox = await sessionTitle.boundingBox();
      const addProjectBox = await addProject.boundingBox();
      const searchBox = await search.boundingBox();
      const sidebarBox = await page.getByTestId("sidebar").boundingBox();
      const searchIconBox = await search.locator("svg").boundingBox();
      expect(projectTitleBox).toBeTruthy();
      expect(sessionTitleBox).toBeTruthy();
      expect(addProjectBox).toBeTruthy();
      expect(searchBox).toBeTruthy();
      expect(sidebarBox).toBeTruthy();
      expect(searchIconBox).toBeTruthy();
      expect(addProjectBox!.width).toBe(44);
      expect(addProjectBox!.height).toBe(44);
      expect(searchBox!.width).toBe(44);
      expect(searchBox!.height).toBe(44);
      const searchIconRightInset = sidebarBox!.x + sidebarBox!.width - (searchIconBox!.x + searchIconBox!.width);
      expect(searchIconRightInset).toBeGreaterThanOrEqual(16);
      expect(searchIconRightInset).toBeLessThanOrEqual(18);
      expect(Math.abs((addProjectBox!.x + addProjectBox!.width / 2) - (searchBox!.x + searchBox!.width / 2))).toBeLessThanOrEqual(1);
      const projectTitleTextLeft = await projectTitle.evaluate((element) =>
        element.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(element).paddingLeft),
      );
      expect(Math.abs(projectTitleTextLeft - sessionTitleBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((sessionTitleBox!.y + sessionTitleBox!.height / 2) - (searchBox!.y + searchBox!.height / 2))).toBeLessThanOrEqual(1);
      await expect(search).toHaveAttribute("aria-expanded", "false");

      await page.screenshot({ path: `${outputDir}/${width === 390 ? "drawer" : "desktop"}-${theme}.png`, animations: "disabled" });

      await search.focus();
      await page.keyboard.press("Enter");
      await expect(search).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("session-search")).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(search).toHaveAttribute("aria-expanded", "false");
    });
  }
}
