import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { SseEvent } from "pi-agent-server/client";
let server: Server;
const streams = new Set<ServerResponse>();
let timer: ReturnType<typeof setInterval>;
let tick = 0;
const projectId = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const sessions = [1, 2].map(n => ({ id: `00000000-0000-4000-8000-00000000010${n}`, projectId, title: `滚动历史 ${n}`, createdAt: n, updatedAt: n, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null }));
function emit(value: SseEvent) { for (const stream of streams) stream.write(`id: ${tick}\ndata: ${JSON.stringify(value)}\n\n`); }
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: projectId, name: "滚动隔离", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions") return json(sessions);
    if (path.endsWith("/control-queue")) return json({ requestId: null, revision: 0, items: [] });
    if (path.endsWith("/export")) return setTimeout(() => json({ lastEventId: 0, messages: [], timeline: [{ type: "message", id: "history", role: "assistant", text: Array.from({ length: 90 }, (_, i) => `历史第 ${i} 行阅读内容。`).join("\n\n"), streaming: false }] }), 200);
    if (path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.flushHeaders(); streams.add(res);
      req.on("close", () => streams.delete(res)); return;
    }
    json({});
  });
  await new Promise<void>(resolve => server.listen(8103, "127.0.0.1", resolve));
});
test.afterAll(async () => { clearInterval(timer); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

// Business flow representatives: light desktop and dark mobile, not the full cross-product.
for (const { theme, width } of [{ theme: "light", width: 1280 }, { theme: "dark", width: 390 }] as const) test(`真实定时混合 SSE 滚动跟随 ${width} ${theme}`, async ({ page }) => {
  clearInterval(timer); tick = 0;
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  if (width === 390) await page.getByRole("button", { name: "打开工作区导航" }).click();
  await page.getByText("滚动历史 1", { exact: true }).click();
  const body = page.getByTestId("chat-body");
  const gap = () => body.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect(body).toContainText("历史第 89 行");
  await expect.poll(gap).toBeLessThan(2);
  await expect.poll(() => streams.size).toBeGreaterThan(0);
  emit({ type: "thinking_delta", text: "开始思考\n" });
  emit({ type: "tool_start", toolCallId: "scroll-tool", toolName: "bash", args: { command: "echo fixture" } });
  timer = setInterval(() => {
    tick++;
    emit({ type: "thinking_delta", text: `思考更新 ${tick}。\n\n` });
    emit({ type: "text_delta", text: `流式正文 ${tick}：足够长的内容用于真实布局增长和滚动验证。\n\n` });
    emit({ type: "tool_update", toolCallId: "scroll-tool", toolName: "bash", partialResult: Array.from({ length: tick }, (_, i) => `输出 ${i}`).join("\n") });
  }, 160);
  await expect.poll(() => tick).toBeGreaterThan(5);
  await expect(body).toContainText("流式正文 6");
  // text_delta completes each preceding thinking row; completed rows fold by
  // default. Explicitly disclose them without scrolling the reader to a button.
  for (const row of await body.locator('.thinking-row[data-expanded="false"]').evaluateAll(rows => rows.map(row => row.getAttribute("data-testid")!))) {
    const header = page.getByTestId(row).locator(".thinking-header");
    await header.dispatchEvent("click");
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }
  await expect(body).toContainText("思考更新 6");
  // Disclosure is intentionally a reading action. Resume follow explicitly
  // before exercising the original follow -> wheel lock -> Home/End behavior.
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect.poll(gap).toBeLessThan(2);
  const viewportBefore = await body.evaluate(el => el.clientHeight);
  await body.hover(); await page.mouse.wheel(0, -600);
  await expect.poll(gap).toBeGreaterThan(100);
  const top = await body.evaluate(el => el.scrollTop);
  const start = tick;
  await expect.poll(() => tick).toBeGreaterThan(start + 5);
  expect(await body.evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  const latest = page.getByRole("button", { name: "回到最新" });
  await expect(latest).toBeVisible();
  expect(await body.evaluate(el => el.clientHeight)).toBe(viewportBefore);
  await mkdir("/tmp/jump-latest-refine", { recursive: true });
  await page.screenshot({ path: `/tmp/jump-latest-refine/away-${width}-${theme}.png` });
  const geometry = await latest.evaluate(el => {
    const r = el.getBoundingClientRect();
    const b = document.querySelector(".chat-body")!.getBoundingClientRect();
    const c = document.querySelector(".chat-footer")!.getBoundingClientRect();
    const face = el.querySelector(".chat-latest-face")!.getBoundingClientRect();
    const composer = document.querySelector(".composer")!.getBoundingClientRect();
    return { height: r.height, width: r.width, faceWidth: face.width, faceHeight: face.height, centerOffset: (r.left + r.right - composer.left - composer.right) / 2, top: r.top, bottom: r.bottom, bodyBottom: b.bottom, composerTop: c.top };
  });
  expect(geometry.faceWidth).toBe(34);
  expect(geometry.faceHeight).toBe(34);
  expect(geometry.centerOffset).toBe(0);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.bodyBottom);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.composerTop);
  console.log(JSON.stringify({ width, awayTop: top, updatesWhileAway: tick - start, geometry }));
  await latest.click(); await expect.poll(gap).toBeLessThan(2);
  await expect(latest).toHaveCount(0);
  expect(await body.evaluate(el => el.clientHeight)).toBe(viewportBefore);
  await body.evaluate(el => {
    document.addEventListener("keydown", event => {
      if (event.key !== "Home" && event.key !== "End") return;
      el.setAttribute(`data-${event.key.toLowerCase()}-prevented`, String(event.defaultPrevented));
      console.log(JSON.stringify({ key: event.key, bodyFocused: document.activeElement === el, targetIsBody: event.target === el, top: el.scrollTop, prevented: event.defaultPrevented }));
    });
  });
  page.on("console", message => { if (/"key":"(Home|End)"/.test(message.text())) console.log(`keydown ${width} ${theme}: ${message.text()}`); });
  await body.focus();
  await expect(body).toBeFocused();
  await page.keyboard.press("Home");
  await expect(body).toHaveAttribute("data-home-prevented", "true");
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(0);
  const home = await body.evaluate(el => el.scrollTop);
  await page.setViewportSize({ width, height: 800 });
  await expect.poll(() => body.evaluate(el => el.clientHeight)).not.toBe(viewportBefore);
  expect(await body.evaluate(el => el.scrollTop)).toBe(0);
  const resizeStart = tick;
  await expect.poll(() => tick).toBeGreaterThan(resizeStart + 3);
  expect(await body.evaluate(el => el.scrollTop)).toBe(0);
  await page.setViewportSize({ width, height: 844 });
  await expect.poll(() => body.evaluate(el => el.clientHeight)).toBe(viewportBefore);
  expect(await body.evaluate(el => el.scrollTop)).toBe(0);
  // Expanding remote completed reasoning while reading Home must not jump down.
  const remoteRow = await body.locator('.thinking-row[data-expanded="false"]').last().getAttribute("data-testid");
  const remoteThinking = page.getByTestId(remoteRow!).locator(".thinking-header");
  await remoteThinking.dispatchEvent("click");
  await expect(remoteThinking).toHaveAttribute("aria-expanded", "true");
  expect(await body.evaluate(el => el.scrollTop)).toBe(0);
  const homeStart = tick;
  await expect.poll(() => tick).toBeGreaterThan(homeStart + 3);
  expect(await body.evaluate(el => el.scrollTop)).toBe(0);
  const input = page.getByTestId("composer-input");
  await input.fill("End keeps editing here");
  await input.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await input.press("End");
  expect(await input.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(22);
  await expect(input).toBeFocused();
  await input.press("Home");
  expect(await input.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(0);
  await expect(body).toHaveAttribute("data-home-prevented", "false");
  await expect(body).toHaveAttribute("data-end-prevented", "false");
  const inputStart = tick;
  await expect.poll(() => tick).toBeGreaterThan(inputStart + 3);
  expect(await body.evaluate(el => el.scrollTop)).toBe(0);
  await expect(latest).toBeVisible();
  await body.focus();
  await expect(body).toBeFocused();
  await page.keyboard.press("End");
  await expect(body).toHaveAttribute("data-end-prevented", "true");
  console.log(JSON.stringify({ width, phase: "after-End", tick, metrics: await body.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop })) }));
  await expect.poll(gap).toBeLessThan(2);
  const endStart = tick;
  for (let i = 1; i <= 6; i++) {
    await expect.poll(() => tick, { intervals: [40] }).toBeGreaterThanOrEqual(endStart + i);
    await expect.poll(gap, { intervals: [40] }).toBeLessThan(2);
  }
  console.log(JSON.stringify({ width, phase: "End-follow", updates: tick - endStart, gap: await gap() }));
  await page.screenshot({ path: `/tmp/jump-latest-refine/follow-${width}-${theme}.png` });
  clearInterval(timer);
  await body.focus(); await page.keyboard.press("PageUp");
  await expect.poll(gap).toBeGreaterThan(100);
  if (width === 390) await page.getByRole("button", { name: "打开工作区导航" }).click();
  await page.getByText("滚动历史 2", { exact: true }).click();
  await expect(body).toContainText("历史第 89 行");
  await expect.poll(gap).toBeLessThan(2);
  await page.screenshot({ path: `/tmp/jump-latest-refine/history-${width}-${theme}.png` });
  console.log(JSON.stringify({ width, historyGap: await gap(), home, followedUpdates: tick }));

  // Short viewport + long draft: the same flow slot stays clear of the Composer.
  await page.setViewportSize({ width, height: 390 });
  await input.fill(Array.from({ length: 30 }, (_, i) => `草稿第 ${i} 行，保持输入可编辑。`).join("\n"));
  await body.focus(); await expect(body).toBeFocused(); await page.keyboard.press("Home");
  await expect(body).toHaveAttribute("data-home-prevented", "true");
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(0);
  await expect(latest).toBeVisible();
  const shortViewport = await body.evaluate(el => el.clientHeight);
  const shortGeometry = await latest.evaluate(el => {
    const r = el.getBoundingClientRect();
    const b = document.querySelector(".chat-body")!.getBoundingClientRect();
    const c = document.querySelector(".composer")!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, bodyBottom: b.bottom, composerTop: c.top, composerBottom: c.bottom };
  });
  expect(shortGeometry.top).toBeGreaterThanOrEqual(shortGeometry.bodyBottom);
  expect(shortGeometry.bottom).toBeLessThanOrEqual(shortGeometry.composerTop);
  expect(shortGeometry.composerBottom).toBeLessThanOrEqual(390);
  expect(shortViewport).toBeGreaterThan(100);
  await page.keyboard.press("Tab");
  await expect(latest).toBeFocused();
  expect(await latest.evaluate(el => el.matches(":focus-visible"))).toBe(true);
  await page.screenshot({ path: `/tmp/jump-latest-refine/short-draft-focus-${width}-${theme}.png` });
  await page.keyboard.press("Enter");
  await expect.poll(gap).toBeLessThan(2);
  await expect(latest).toHaveCount(0);
  expect(await body.evaluate(el => el.clientHeight)).toBe(shortViewport);
  await page.screenshot({ path: `/tmp/jump-latest-refine/short-draft-bottom-${width}-${theme}.png` });
  console.log(JSON.stringify({ width, theme, shortViewport, shortGeometry }));

  // A local image draft does not upload or send anything to the fixture.
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "pixel.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByTestId("composer-attachment")).toBeVisible();
  await body.focus(); await expect(body).toBeFocused(); await page.keyboard.press("Home");
  await expect(body).toHaveAttribute("data-home-prevented", "true");
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(0);
  await expect(latest).toBeVisible();
  const attachmentGeometry = await latest.evaluate(el => {
    const r = el.getBoundingClientRect();
    const a = document.querySelector(".composer-attachments")!.getBoundingClientRect();
    const b = document.querySelector(".chat-body")!.getBoundingClientRect();
    return { buttonTop: r.top, buttonBottom: r.bottom, attachmentTop: a.top, bodyBottom: b.bottom };
  });
  expect(attachmentGeometry.buttonTop).toBeGreaterThanOrEqual(attachmentGeometry.bodyBottom);
  expect(attachmentGeometry.buttonBottom).toBeLessThanOrEqual(attachmentGeometry.attachmentTop);
  await page.screenshot({ path: `/tmp/jump-latest-refine/short-draft-attachment-${width}-${theme}.png` });
  await latest.click();
  await expect.poll(gap).toBeLessThan(2);
  await expect(latest).toHaveCount(0);
  const last = body.locator(".markdown p").last();
  await expect(last).toContainText("历史第 89 行");
  const lastBox = await last.boundingBox();
  const bodyBox = await body.boundingBox();
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(bodyBox!.y + bodyBox!.height + 1);
  console.log(JSON.stringify({ width, theme, attachmentGeometry }));
});
