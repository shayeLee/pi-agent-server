import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

let server: Server;
let stream: ServerResponse | undefined;
let finalSent = false;
let abortRequested = false;
const sessionId = "00000000-0000-4000-8000-000000000097";
const projectId = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const session = { id: sessionId, projectId, title: "工具流测试", createdAt: 1, updatedAt: 1,
  modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
let eventId = 0;
function emit(value: unknown) { stream?.write(`id: ${++eventId}\ndata: ${JSON.stringify(value)}\n\n`); }

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: projectId, name: "隔离测试", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions") return req.method === "POST" ? json(session, 201) : json([]);
    if (path.endsWith("/export")) return json({ lastEventId: 0, messages: [], timeline: [] });
    if (path.endsWith("/abort")) { abortRequested = true; res.writeHead(204); return res.end(); }
    if (path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders(); stream = res;
      req.on("close", () => { if (stream === res) stream = undefined; });
      return;
    }
    if (path.endsWith("/messages")) {
      req.resume();
      setTimeout(() => emit({ type: "tool_start", toolCallId: "stream-tool", toolName: "bash", args: { command: "printf '第一行\\n第二行\\n'", timeout: 0 } }), 200);
      setTimeout(() => emit({ type: "tool_update", toolCallId: "stream-tool", toolName: "bash", partialResult: { content: [{ type: "text", text: "第一行\n" }], details: { snapshot: 1 } } }), 400);
      setTimeout(() => emit({ type: "tool_update", toolCallId: "stream-tool", toolName: "bash", partialResult: { content: [{ type: "text", text: "第一行\n第二行\n" }], details: { snapshot: 2 } } }), 1800);
      setTimeout(() => {
        finalSent = true;
        emit({ type: "tool_end", toolCallId: "stream-tool", toolName: "bash", result: { content: [{ type: "text", text: "最终结果\n完整原文" }], details: { exitCode: 0 } }, isError: false });
        emit({ type: "completed" });
      }, 4000);
      return json({ status: "accepted" }, 202);
    }
    json({ error: `Unexpected fixture path ${path}` }, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8097, "127.0.0.1", resolve); });
});
test.afterAll(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

test("真实定时 SSE 在完成前显示两次可读快照，最终替换且原始数据可达", async ({ page }) => {
  await mkdir("/tmp/tool-streaming-readable", { recursive: true });
  await page.goto("/");
  await page.getByTestId("composer-input").fill("运行隔离工具");
  await page.getByTestId("send-button").click();
  const card = page.getByTestId("tool-call-card");
  await expect(card.locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
  const output = card.getByTestId("tool-result-text").locator('.code-block[data-language="bash"] pre');
  await expect(output).toHaveText("第一行\n");
  const stop = page.getByTestId("abort-button");
  await expect(stop).toBeVisible();
  await mkdir("/tmp/stop-button-visible", { recursive: true });
  for (const [theme, width, height] of [["dark", 1400, 900], ["light", 1400, 900], ["dark", 390, 844], ["light", 390, 844]] as const) {
    await page.setViewportSize({ width: 1400, height: 900 });
    if (await page.getByTestId("app").getAttribute("data-theme") !== theme) await page.getByTestId("theme-toggle").click();
    await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    const measurements = await stop.evaluate((button) => {
      const composer = button.closest(".composer")!;
      const rect = button.getBoundingClientRect();
      const icon = button.querySelector("rect")!.getBoundingClientRect();
      const buttonStyle = getComputedStyle(button);
      const composerStyle = getComputedStyle(composer);
      return { button: { width: rect.width, height: rect.height, centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2 },
        icon: { width: icon.width, height: icon.height }, buttonBg: buttonStyle.backgroundColor, composerBg: composerStyle.backgroundColor,
        buttonColor: buttonStyle.color };
    });
    expect(measurements.buttonBg).not.toBe(measurements.composerBg);
    expect(measurements.icon.width).toBe(10);
    expect(measurements.icon.height).toBe(10);
    expect(measurements.button.width).toBe(width === 390 ? 44 : 34);
    expect(measurements.button.height).toBe(width === 390 ? 44 : 34);
    expect(measurements.button.centerX).toBeGreaterThan(0);
    expect(measurements.button.centerY).toBeGreaterThan(0);
    await page.screenshot({ path: `/tmp/stop-button-visible/${theme}-${width}.png` });
  }
  expect(finalSent).toBe(false);
  const abortRequest = page.waitForRequest((request) => request.url().endsWith("/abort") && request.method() === "POST");
  await stop.click();
  await abortRequest;
  await expect.poll(() => abortRequested).toBe(true);
  expect(finalSent).toBe(false);
  await expect(card).toHaveAttribute("data-done", "false");
  await expect(output).toBeVisible();
  await expect(card.locator(".tool-parameters")).toContainText("command");
  await expect(card.locator(".tool-parameters")).toContainText("printf '第一行\\n第二行\\n'");
  await page.screenshot({ path: "/tmp/tool-streaming-readable/01-first.png" });
  await expect(output).toHaveText("第一行\n第二行\n");
  expect(finalSent).toBe(false);
  expect(await output.textContent()).toBe("第一行\n第二行\n");
  await page.screenshot({ path: "/tmp/tool-streaming-readable/02-second.png" });
  const header = card.locator(".tool-call-header");
  await header.click(); await header.click(); // Explicitly keep the result open on completion.
  await expect(card).toHaveAttribute("data-done", "true");
  await expect(output).toHaveText("最终结果\n完整原文");
  await card.getByRole("button", { name: "工具更多操作" }).click();
  await card.getByRole("menuitem", { name: "查看原始数据" }).click();
  await expect(page.getByRole("dialog", { name: "原始数据 · bash" })).toContainText('"exitCode": 0');
  await expect(card.getByRole("button", { name: "复制原始数据" })).toBeVisible();
  await page.screenshot({ path: "/tmp/tool-streaming-readable/03-final-raw.png" });
});
