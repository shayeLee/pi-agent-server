import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
  test(`diff + thinking cleanup ${theme} ${width}`, async ({ page, context }) => {
    await mkdir("/tmp/diff-thinking-cleanup", { recursive: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`/visual-fixtures/diff-thinking-cleanup.html?theme=${theme}`);
    const original = await page.evaluate(async () => {
      const { args, huge, fullThinking } = await import("/visual-fixtures/diff-thinking-cleanup.tsx");
      return { args, huge, fullThinking };
    });
    await expect(page.locator(".thinking-row")).toHaveCount(0);
    await page.getByRole("button", { name: "真实思考到达" }).click();
    const thinking = page.getByTestId("thinking-late");
    await expect(thinking.locator(".thinking-summary")).toHaveCount(0);
    // Thinking starts collapsed even while streaming; only the reader opens it.
    await expect(thinking.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await thinking.getByRole("button").click();
    expect(await thinking.locator(".thinking-body").textContent()).toBe(original.fullThinking);
    const style = await thinking.locator(".thinking-body").evaluate(el => {
      const computed = getComputedStyle(el);
      return { font: computed.fontSize, token: computed.getPropertyValue("--font-md").trim() };
    });
    // Size comes from the type scale token, never a hard-coded value.
    expect(style.token).not.toBe("");
    expect(style.font).toBe(style.token);
    await thinking.getByRole("button").click();
    await page.getByRole("button", { name: "结束思考" }).click();
    await expect(thinking.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    const edit = page.locator('[data-tool-call-id="edit"]');
    await expect(edit.locator(".tool-summary-preview")).toHaveAttribute("title", original.args.path + " · 5 项修改");
    // The running edit starts collapsed too; open it to read the diff.
    await edit.locator(".tool-call-header").click();
    await expect(edit.locator(".diff-block")).toHaveCount(5);
    await expect(edit.locator("dt, details, .code-block, ol")).toHaveCount(0);
    await expect(edit.getByText("片段相同（无修改）")).toBeVisible();
    await expect(edit.locator(".diff-no-newline")).toHaveCount(0);
    expect(await edit.locator(".diff-block").nth(1).textContent()).toContain("- old\n+ new");
    await expect(edit.locator('.tool-call-body > :not(section)')).toHaveCount(0);
    const result = page.locator('[data-tool-call-id="result"]');
    await result.locator(".tool-call-header").click();
    await expect(result.getByTestId("tool-result-text")).toHaveText("真实错误结果：replacement failed; 原文保留");
    await page.screenshot({ path: `/tmp/diff-thinking-cleanup/${theme}-${width}.png`, fullPage: true });
    const large = page.locator('[data-tool-call-id="large"]');
    await large.locator(".tool-call-header").click();
    await expect(large.locator(".diff-lines, details")).toHaveCount(0);
    await large.locator('.diff-block').getByRole("button", { name: "查看原始数据", exact: true }).click();
    const fallback = page.getByRole("dialog", { name: "原始数据 · edit 片段" });
    expect(await fallback.locator("pre").first().textContent()).toBe(original.huge);
    await fallback.getByRole("button", { name: "复制 oldText" }).click();
    await expect(fallback.getByRole("status").first()).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original.huge);
    await fallback.getByRole("button", { name: "复制 newText" }).click();
    await expect(fallback.getByRole("status").last()).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("\tnew\r\n\n");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
