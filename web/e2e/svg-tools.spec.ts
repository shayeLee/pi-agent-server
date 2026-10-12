import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
test("tool Markdown never requests unknown images or executes HTML", async ({ page }) => {
  const payload = '# Tool result\n\n- complete\n\n![remote](https://example.invalid/tracking.png)\n\n![inline](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)\n\n![relative](/tracking.png)\n\n<img src="/tracking.png" onerror="window.__toolHtmlExecuted=true">\n<script>window.__toolHtmlExecuted=true</script>';
  const requestedImages: string[] = [];
  page.on("request", request => {
    if (request.resourceType() === "image" || request.url().includes("tracking.png")) requestedImages.push(request.url());
  });
  await page.route("**/visual-fixtures/svg-tools.tsx", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/export const waitText = .*?;\n/, `export const waitText = ${JSON.stringify(payload)};\n`);
    await route.fulfill({ response, body });
  });
  await page.goto("/visual-fixtures/svg-tools.html");
  const card = page.getByTestId("tool-call-card").last();
  await expect(card.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
  await card.locator('.tool-call-header').click();
  await expect(card.getByRole("heading", { name: "Tool result" })).toBeVisible();
  await expect(card.locator(".markdown img, .markdown script")).toHaveCount(0);
  await expect(card.getByRole("link", { name: "remote" })).toHaveAttribute("href", "https://example.invalid/tracking.png");
  await expect(card.getByText("inline", { exact: true })).not.toHaveAttribute("href");
  await card.getByRole("button", { name: "Markdown 展示" }).click();
  expect(await card.locator(".tool-readable-value").textContent()).toBe(payload);
  await card.getByRole("button", { name: "Markdown 展示" }).click();
  await expect(card.getByRole("heading", { name: "Tool result" })).toBeVisible();
  expect(requestedImages).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, "__toolHtmlExecuted"))).toBeUndefined();
});

for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
  test(`reference payloads / ${theme} / ${width}`, async ({ page, context }) => {
    await mkdir("/tmp/agent-heading-bash-plain", { recursive: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`/visual-fixtures/svg-tools.html?theme=${theme}`);
    const cards = page.getByTestId("tool-call-card");
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) {
      await expect(card.locator('.tool-call-header')).toHaveAttribute('aria-expanded', 'false');
      await card.locator('.tool-call-header').click();
    }
    await expect(cards.last().getByRole("heading", { name: "[lite] run 2 — completed" })).toBeVisible();
    await expect(cards.last().locator(".markdown li")).toHaveCount(3);
    await expect(cards.nth(0).getByRole("button", { name: "Markdown 展示" })).toHaveCount(0);
    await expect(cards.nth(0).locator(".tool-result-text pre")).toHaveText(/review-sample.py  modified=/);
    const taskItems = cards.nth(1).getByRole("list", { name: "代理任务" }).locator("li");
    await expect(taskItems.nth(0).locator(".tool-subagent-agent")).toHaveText("lite");
    await expect(taskItems.nth(1).locator(".tool-subagent-agent")).toHaveText("reviewer");
    expect(await taskItems.first().evaluate(element => getComputedStyle(element.parentElement!).listStyleType)).toBe("none");
    await expect(taskItems.nth(0).locator(".tool-subagent-agent")).not.toContainText("task");
    await expect(cards.nth(2).getByRole("button", { name: "Markdown 展示" })).toBeVisible();
    await expect(cards.last().locator(".markdown code").first()).toHaveText("/Users/mz/pi-default-project/lite-smoke-test.txt");
    for (let index = 0; index < 3; index++) {
      await cards.nth(index).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/agent-heading-bash-plain/${theme}-${width}-${["bash", "parallel", "wait"][index]}.png` });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const wait = cards.last();
    const original = await page.evaluate(async () => (await import("/visual-fixtures/svg-tools.tsx")).waitText);
    await wait.getByRole("button", { name: "Markdown 展示" }).click();
    expect(await wait.locator(".tool-readable-value").textContent()).toBe(original);

    await cards.first().locator(".tool-parameters").getByRole("button", { name: "复制代码" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('stat -f "%N  modified=%Sm size=%z" review-sample.py lite-smoke-test.txt worker-smoke-test.txt');
  });
}
