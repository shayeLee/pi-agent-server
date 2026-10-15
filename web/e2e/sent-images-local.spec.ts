import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// Generated 32x32 orange PNG, no user images or sessions.
const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGP4n2ZMU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAIAlYFtUlL3ZAAAAAElFTkSuQmCC";
const projectId = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const sessionId = "00000000-0000-4000-8000-000000000091";
const otherId = "00000000-0000-4000-8000-000000000093";

async function selectSession(page: Page, id: string, label: string) {
  const selection = page.locator(`.session-select[data-testid="session-${id}"]`);
  await selection.hover();
  const hit = await selection.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { tag: element.tagName, className: element.className, width: box.width,
      centerTarget: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        ?.closest("button")?.getAttribute("data-testid") };
  });
  await writeFile(`/tmp/sent-image-fix/hit-after-${label}.json`, JSON.stringify(hit, null, 2));
  expect(hit.centerTarget).toBe(`session-${id}`);
  await selection.click();
}

for (const count of [1, 2]) test(`accepted ${count} image(s): composer clears, timeline and refreshed history retain actual bytes`, async ({ page }) => {
  let created = false;
  let accepted: { prompt: string; images: { mediaType: string; base64: string }[] } | null = null;
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    const session = { id: sessionId, ownerKey: "fixture", projectId, title: "图片测试", createdAt: 1, updatedAt: 1,
      modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: projectId, name: "隔离 fixture", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions" && request.method() === "GET") return json([...(created ? [session] : []), { ...session, id: otherId, title: "另一个会话" }]);
    if (path === "/v1/sessions" && request.method() === "POST") { created = true; return json(session, 201); }
    if (path.endsWith("/events")) return route.fulfill({ status: 204, body: "" });
    // Running sessions read the resident queue and poll live subagents; this fixture has neither.
    if (path.endsWith("/control-queue")) return json({ requestId: null, revision: 0, items: [] });
    if (path.endsWith("/subagents")) return json({ sessionId: path.split("/")[3], runs: [] });
    if (path.endsWith("/export")) return json({ lastEventId: 0,
      messages: accepted && path.includes(sessionId) ? [{ sourceId: "fixture-user", role: "user", text: accepted.prompt, images: accepted.images }] : [],
      timeline: accepted && path.includes(sessionId) ? [{ id: "message:fixture-user", messageId: "fixture-user", type: "message", role: "user", text: accepted.prompt, order: 0 }] : [] });
    if (path.endsWith("/messages") && request.method() === "POST") {
      accepted = request.postDataJSON();
      expect(accepted).toMatchObject({ prompt: count === 2 ? "文字和两张图片" : "",
        images: Array.from({ length: count }, () => ({ mediaType: "image/png", base64: png })) });
      return json({ status: "accepted" }, 202);
    }
    throw new Error(`Unexpected fixture request: ${request.method()} ${path}`);
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.getByTestId("composer-file-input").setInputFiles(Array.from({ length: count }, (_, index) => ({
    name: `generated-${index}.png`, mimeType: "image/png", buffer: Buffer.from(png, "base64"),
  })));
  await expect(page.getByTestId("composer-attachment")).toHaveCount(count);
  if (count === 2) await page.getByTestId("composer-input").fill("文字和两张图片");
  await expect(page.getByTestId("send-button")).toBeEnabled();
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("composer-attachment")).toHaveCount(0);
  const images = page.locator(".message-images img");
  await expect(images).toHaveCount(count);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute("src", `data:image/png;base64,${png}`);
    expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(32);
  }
  await mkdir("/tmp/sent-image-fix", { recursive: true });
  await page.screenshot({ path: `/tmp/sent-image-fix/accepted-${count}.png`, fullPage: true });
  await page.getByRole("button", { name: "预览图片 1", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await page.screenshot({ path: `/tmp/sent-image-fix/preview-${count}.png` });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "图片预览" })).toHaveCount(0);
  await selectSession(page, otherId, `other-${count}`);
  await expect(images).toHaveCount(0);
  await selectSession(page, sessionId, `return-${count}`);
  await expect(images).toHaveCount(count);
  await page.screenshot({ path: `/tmp/sent-image-fix/returned-${count}.png`, fullPage: true });
  await page.reload();
  await selectSession(page, sessionId, `reload-${count}`);
  await expect(images).toHaveCount(count);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute("src", `data:image/png;base64,${png}`);
    expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(32);
  }
  await page.screenshot({ path: `/tmp/sent-image-fix/restored-${count}.png`, fullPage: true });
  await page.getByRole("button", { name: `预览图片 ${count}`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" }).locator("img")).toHaveAttribute("src", `data:image/png;base64,${png}`);
  await page.screenshot({ path: `/tmp/sent-image-fix/restored-preview-${count}.png` });
  await page.keyboard.press("Escape");
  await page.getByTestId(`session-${sessionId}`).hover();
  const dialog = page.waitForEvent("dialog");
  await page.getByTestId(`session-menu-${sessionId}`).click();
  const renameClick = page.getByTestId(`rename-${sessionId}`).click();
  const prompt = await dialog;
  expect(prompt.type()).toBe("prompt");
  await prompt.dismiss();
  await renameClick;
});
