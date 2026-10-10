import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
const tokens = { input: 123456, output: 2345, cacheRead: 80000, cacheWrite: 2000, totalTokens: 207801, costUsdEstimate: 0.0123456789 };
const usageSnapshot = {
  lastResponse: { ...tokens, ordinal: 2, cacheHitPercent: 38.938773290, speed: { outputTokens: 2345, generationDurationMs: 5000, tokensPerSecond: 469 } },
  sessionTotals: { ...tokens, input: 1234567, output: 34567, totalTokens: 2345678, costUsdEstimate: 1.23456789, scope: "allEntries" },
  context: { tokens: 42678, window: 200000, percent: 21.339, estimate: true },
};
let server: Server;
const streams = new Set<ServerResponse>();
const projectId = "stats-project";
const session = { id: "stats-session", projectId, title: "统计隔离 fixture", createdAt: 1, updatedAt: 1, modelProvider: "fixture", modelId: "model", thinkingLevel: "off", systemPrompt: null };
let sequence = 0;
function emit(value: object) { for (const stream of streams) stream.write(`id: ${++sequence}\ndata: ${JSON.stringify(value)}\n\n`); }
test.beforeAll(async () => {
  await mkdir("/tmp/stats-single-line", { recursive: true });
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: projectId, name: "Stats", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [{ provider: "fixture", id: "model", name: "Fixture Model" }], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions") return json([session]);
    if (path.endsWith("/export")) return json({ usageSnapshot, lastEventId: sequence, messages: [], timeline: [
      { type: "message", id: "u", role: "user", text: "只调整下方统计，不移动模型选择。" },
      ...Array.from({ length: 11 }, (_, i) => [
        { type: "tool_call", id: `t${i}`, toolCallId: `t${i}`, toolName: "bash", args: { command: `echo ${i}` } },
        { type: "tool_result", id: `r${i}`, toolCallId: `t${i}`, toolName: "bash", result: "fixture complete", isError: false },
      ]).flat(),
      { type: "message", id: "a", role: "assistant", text: "隔离的真实 App HTTP/SSE fixture，没有调用模型或用户数据库。" },
    ] });
    if (path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.flushHeaders(); streams.add(res);
      req.on("close", () => streams.delete(res)); return;
    }
    json({});
  });
  await new Promise<void>(resolve => server.listen(8111, "127.0.0.1", resolve));
});
test.afterAll(async () => { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
// Business flow representatives: light desktop and dark mobile, not the full cross-product.
for (const { theme, width } of [{ theme: "light", width: 1280 }, { theme: "dark", width: 390 }] as const) test(`Stats real App ${theme} ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: theme }); await page.goto("/");
  if (width === 390) await page.getByRole("button", { name: "打开工作区导航" }).click();
  await page.getByTestId(`session-${session.id}`).click();
  await expect(page.getByTestId("stat-steps")).toHaveText("工具 11 次");
  await expect.poll(() => streams.size).toBeGreaterThan(0);
  if (width === 390) await expect.poll(async () => { const box = await page.getByTestId("sidebar").boundingBox(); return box ? box.x + box.width : 0; }).toBeLessThanOrEqual(0);
  const bar = page.getByTestId("stats-bar");
  const trigger = page.getByRole("button", { name: "查看统计详情" });
  await expect(page.getByTestId("stat-summary-speed")).toHaveText("469 tok/s");
  await expect(page.getByTestId("stat-summary-tokens")).toHaveText("208K tok");
  await expect(page.getByTestId("stat-input")).toHaveCount(0);
  const geometry = await bar.evaluate(el => ({ height: el.getBoundingClientRect().height, width: el.clientWidth, scrollWidth: el.scrollWidth,
    groups: Array.from(el.querySelectorAll('.stats-cluster')).map(g => ({ y: g.getBoundingClientRect().y, height: g.getBoundingClientRect().height })), font: getComputedStyle(el.querySelector('button')!).fontSize }));
  expect(geometry.height).toBeLessThanOrEqual(36); expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  expect(new Set(geometry.groups.map(g => g.y)).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await writeFile(`/tmp/stats-single-line/${theme}-${width}-geometry.json`, JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}.png` });
  await bar.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-bar.png` });
  const picker = await page.locator('.model-thinking-picker').boundingBox();
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('stat-input')).toHaveAttribute('title', /123,456 tokens/);
  await expect(page.getByTestId('stat-session-tokens')).toHaveAttribute('title', /2,345,678/);
  await expect(page.getByTestId('stat-cache-write')).toHaveAttribute('title', /2,000/);
  emit({ type: "usage", ...usageSnapshot, promptTokens: tokens.input, completionTokens: tokens.output, totalTokens: tokens.totalTokens, durationMs: 12500, ttftMs: 345 });
  await expect(page.getByTestId('stat-duration')).toContainText('12.5 秒');
  await expect(page.getByTestId('stat-ttft')).toContainText('345');
  await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-details.png` });
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  expect(await page.locator('.model-thinking-picker').boundingBox()).toEqual(picker);
  await page.getByTestId('composer-input').fill('短屏草稿与附件');
  await page.getByTestId('composer-file-input').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByTestId('composer-attachment')).toBeVisible(); await page.setViewportSize({ width, height: 390 });
  await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-short.png` });
  await expect(bar).toBeHidden(); // Existing short-height policy remains unchanged.
  await page.setViewportSize({ width, height: 844 });
  emit({ type: 'status', phase: 'agent_start' });
  await expect(page.getByTestId('stat-summary-speed')).toHaveCount(0);
  emit({ type: 'usage', ...usageSnapshot, promptTokens: tokens.input, completionTokens: tokens.output, totalTokens: tokens.totalTokens, durationMs: 12500, ttftMs: 345 });
  emit({ type: 'model_output_progress', ordinal: 3, phase: 'delta', tokensPerSecondEstimate: 100, includesThinking: true });
  await expect(page.getByTestId('stat-live-speed')).toHaveText('~100 tok/s');
  await expect(page.getByTestId('stat-summary-tokens')).toHaveText('208K tok');
  expect(await bar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-rich-active.png` });
  emit({ type: 'usage', promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, ttftMs: 0 }); emit({ type: 'aborted' });
  await trigger.click(); await expect(page.getByTestId('stat-output')).toHaveText('输出 0'); await expect(page.getByTestId('stat-ttft')).toHaveCount(0);
  emit({ type: 'usage', promptTokens: null, completionTokens: null, totalTokens: null, durationMs: 100, ttftMs: 100 });
  await expect(page.getByTestId('stat-output')).toHaveCount(0); await page.keyboard.press('Escape');
  await page.reload(); if (width === 390) await page.getByRole('button', { name: '打开工作区导航' }).click();
  await page.getByTestId(`session-${session.id}`).click(); await expect(page.getByTestId('stat-summary-tokens')).toHaveText('208K tok');
});
