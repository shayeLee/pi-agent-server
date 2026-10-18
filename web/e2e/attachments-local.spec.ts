import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const projectId = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const sessionId = "00000000-0000-4000-8000-000000000091";
const fileId = "00000000-0000-4000-8000-000000000092";

test("Reading-first local fixture: file upload, explicit first send, theme and phone layout", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const messages: Array<{ prompt: string; fileIds?: string[]; images?: unknown[] }> = [];
  let created = 0;
  let uploads = 0;
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    const session = { id: sessionId, ownerKey: "local", projectId, title: "", createdAt: 1, updatedAt: 1,
      modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: projectId, name: "本地项目", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [{ provider: "fixture", id: "model/long-id", name: "Fixture" }],
      thinkingLevels: ["off", "medium"], defaultModel: null, defaultThinkingLevel: "medium" });
    if (path === "/v1/sessions" && request.method() === "GET") return json(created ? [session] : []);
    if (path === "/v1/files" && request.method() === "POST") {
      uploads++;
      expect(request.postDataBuffer()?.toString()).toBe("local fixture bytes");
      return json({ fileId, name: "notes.txt", mediaType: "text/plain", size: 19,
        status: "ready", agentPath: "/private/fixture/file" }, 201);
    }
    if (path === "/v1/sessions" && request.method() === "POST") { created++; return json(session, 201); }
    if (path === `/v1/sessions/${sessionId}/export`) return json({ messages: [], timeline: [], lastEventId: 0 });
    if (path === `/v1/sessions/${sessionId}/events`) return route.fulfill({ status: 204, body: "" });
    if (path === `/v1/sessions/${sessionId}/messages` && request.method() === "POST") {
      messages.push(request.postDataJSON() as (typeof messages)[number]);
      return json({ status: "accepted" }, 202);
    }
    return json({ statusCode: 404, error: "Not Found", message: "fixture route missing" }, 404);
  });

  await page.setViewportSize({ width: 1235, height: 390 });
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();
  await expect(page.getByTestId("composer-project-select")).toHaveCount(0);
  await expect(page.getByTestId("model-thinking-trigger")).toBeVisible();
  await expect(page.getByTestId("thinking-trigger")).toBeVisible();
  await page.getByTestId("new-session").click();
  expect(created).toBe(0);
  await page.getByTestId("composer-input").fill(Array.from({ length: 14 }, (_, index) => `草稿第 ${index + 1} 行`).join("\n"));
  await page.getByTestId("composer-file-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain",
    buffer: Buffer.from("local fixture bytes") });
  await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
  expect(created).toBe(0);
  expect(messages).toHaveLength(0);

  await mkdir("/tmp/reading-first-actual", { recursive: true });
  for (const viewport of [{ width: 1235, height: 390 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const title = rect(".workbench-welcome-copy");
      const footer = rect(".chat-footer");
      const targets = ["[data-testid=composer-input]", '[aria-label="添加附件"]', '[data-testid=send-button]'];
      const targetRects = targets.map((selector) => rect(selector));
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return {
        footerPosition: getComputedStyle(document.querySelector(".chat-footer")!).position,
        titleOverlapsFooter: overlaps(title, footer),
        titleOverlapsControls: targetRects.map((box) => overlaps(title, box)),
        controlsInsideViewport: targetRects.map((box) => box.top >= 0 && box.bottom <= innerHeight),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    await page.screenshot({ path: `/tmp/reading-first-actual/start-empty-${viewport.width}x${viewport.height}.png`, animations: "disabled" });
    expect(layout.footerPosition).toBe("static");
    expect(layout.titleOverlapsFooter).toBe(false);
    expect(layout.titleOverlapsControls).toEqual([false, false, false]);
    expect(layout.controlsInsideViewport).toEqual([true, true, true]);
    expect(layout.horizontalOverflow).toBe(false);
  }
  expect(created).toBe(0);
  expect(messages).toHaveLength(0);
  await page.setViewportSize({ width: 1235, height: 390 });
  await page.screenshot({ path: "/tmp/reading-first-actual/attachment-sent-dark.png", fullPage: true });

  await page.getByTestId("composer-input").fill("阅读这个文件");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("chat-header")).toBeVisible();
  // Create and send are separate requests: the header can render before the send reaches the fixture.
  await expect.poll(() => messages.length).toBe(1);
  expect(created).toBe(1);
  expect(uploads).toBe(1);
  expect(messages).toEqual([expect.objectContaining({ prompt: "阅读这个文件", fileIds: [fileId] })]);
  expect(JSON.stringify(messages)).not.toContain("/private/fixture/file");
  await page.getByTestId("settings-toggle").click();
  await page.getByRole("menuitemradio", { name: "浅色" }).click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "/tmp/reading-first-actual/attachment-sent-light.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "打开工作区导航" })).toBeVisible();
  await expect(page.getByTestId("sidebar")).not.toBeVisible();
  await expect(page.getByTestId("composer")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "/tmp/reading-first-actual/attachment-phone.png" });
  await page.getByRole("button", { name: "打开工作区导航" }).click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.screenshot({ path: "/tmp/reading-first-actual/attachment-phone-drawer.png" });
  // Tap the exposed backdrop strip on the right without hardcoded coordinates
  const backdrop = page.getByRole("button", { name: "关闭工作区导航" });
  const backdropBox = (await backdrop.boundingBox())!;
  await backdrop.click({ position: { x: backdropBox.width - 20, y: backdropBox.height / 2 } });
  await expect(page.getByTestId("sidebar")).not.toBeVisible();
  await page.screenshot({ path: "/tmp/reading-first-actual/attachment-phone-closed.png" });

  // A tall unsent draft plus a ready attachment must not cover the last real band.
  await page.getByTestId("composer-input").fill(Array.from({ length: 14 }, (_, index) => `草稿第 ${index + 1} 行`).join("\n"));
  await page.getByTestId("composer-file-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain",
    buffer: Buffer.from("local fixture bytes") });
  await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
  await page.getByTestId("chat-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const lastBand = await page.getByTestId("message-list").locator(".row-user").last().boundingBox();
  const body = await page.getByTestId("chat-body").boundingBox();
  const footer = await page.locator(".chat-footer").boundingBox();
  expect(lastBand && body && footer && lastBand.y >= body.y &&
    lastBand.y + lastBand.height <= footer.y + 1 && body.y + body.height <= footer.y + 1).toBeTruthy();
  await page.screenshot({ path: "/tmp/reading-first-actual/attachment-phone-expanded.png" });
});
