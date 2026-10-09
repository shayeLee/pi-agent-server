import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

let server: Server;
let stream: ServerResponse | undefined;
let eventId = 0;
const dir = "/tmp/subagent-markdown-default";
const session = { id: "00000000-0000-4000-8000-000000000098", projectId: "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c", title: "代理 Markdown 隔离验证", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
const emit = (value: unknown) => stream!.write(`id: ${++eventId}\ndata: ${JSON.stringify(value)}\n\n`);
const result = (text: string) => ({ content: [{ type: "text", text }], details: { exact: [0, false, null], hidden: "## Never render metadata" } });
test.beforeAll(async () => {
  await mkdir(dir, { recursive: true });
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: session.projectId, name: "隔离验证", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions") return json(req.method === "POST" ? session : [], req.method === "POST" ? 201 : 200);
    if (path.endsWith("/export")) return json({ lastEventId: 0, messages: [], timeline: [] });
    if (path.endsWith("/events")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); stream = res; req.on("close", () => { if (stream === res) stream = undefined; }); return; }
    if (path.endsWith("/messages")) { req.resume(); return json({ status: "accepted" }, 202); }
    json({ error: path }, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8098, "127.0.0.1", resolve); });
});
test.afterAll(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

for (const theme of ["dark", "light"]) for (const width of [1280, 390]) test(`${theme} ${width}: parallel and wait streaming default, manual plain and exact raw`, async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], hasTouch: width === 390 });
  const page = await context.newPage();
  let unexpectedLoads = 0;
  page.on("request", req => { if (req.url().includes("tracker.png")) unexpectedLoads++; });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/");
  if (await page.getByTestId("app").getAttribute("data-theme") !== theme) await page.getByTestId("theme-toggle").click();
  await page.setViewportSize({ width, height: 1000 });
  await page.getByTestId("composer-input").fill("检查并行与等待 Markdown");
  await page.getByTestId("send-button").click();
  await expect.poll(() => !!stream).toBe(true);
  for (const toolName of ["subagent", "subagent_wait"]) {
    const args = toolName === "subagent" ? { tasks: [{ agent: "scout", task: "检查完整输出与信息层级" }, { agent: "worker", task: "保留精确原文与流式偏好", cwd: "/fixture" }] } : { runIds: ["1", "2"], timeoutMs: 600000 };
    emit({ type: "tool_start", toolCallId: toolName, toolName, args });
    const card = page.locator(`[data-tool-call-id="${toolName}"]`);
    const header = card.locator(".tool-call-header");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await header.click(); await header.click();
    emit({ type: "tool_update", toolCallId: toolName, toolName, partialResult: result("## 正在检查") });
    await expect(card.getByRole("heading", { name: "正在检查" })).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${theme}-${width}-${toolName}-partial.png` });
    await card.getByRole("button", { name: "Markdown 展示" }).click();
    const partial = "- 第二次快照\n  保留空格\n";
    emit({ type: "tool_update", toolCallId: toolName, toolName, partialResult: result(partial) });
    await expect(card.locator(".tool-readable-value").last()).toHaveText(partial);
    const text = partial + '\n## 检查完成\n\n<script>window.__unsafe = true</script>\n<img src="/tracker.png" onerror="window.__unsafe=true">\n\n![remote](https://example.invalid/tracker.png)\n\n```text\n## literal heading\n- literal list\n```\n';
    const final = result(text);
    emit({ type: "tool_end", toolCallId: toolName, toolName, result: final, isError: false });
    await expect(card).toHaveAttribute("data-done", "true");
    await expect(card.getByRole("button", { name: "Markdown 展示" })).toHaveAttribute("aria-pressed", "false");
    expect(await card.getByTestId("tool-result-text").locator("pre").textContent()).toBe(text);
    await page.screenshot({ path: `${dir}/${theme}-${width}-${toolName}-plain-final.png` });
    await card.getByRole("button", { name: "Markdown 展示" }).click();
    await expect(card.getByRole("heading", { name: "检查完成" })).toBeVisible();
    await expect(card.locator("img, script")).toHaveCount(0);
    expect(await card.locator(".code-block pre").textContent()).toBe("## literal heading\n- literal list\n");
    await expect(card.getByRole("heading", { name: "literal heading" })).toHaveCount(0);
    await expect(card.getByRole("heading", { name: "Never render metadata" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __unsafe?: boolean }).__unsafe)).toBeUndefined();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${theme}-${width}-${toolName}-markdown-final.png` });
    await card.getByRole("button", { name: "工具更多操作" }).click();
    await card.getByRole("menuitem", { name: "查看原始数据" }).click();
    const raw = JSON.parse((await page.getByRole("dialog").locator("pre").textContent())!);
    expect(raw.args).toEqual(args); expect(raw.result).toEqual(final);
    await page.getByRole("dialog").getByRole("button", { name: "复制原始数据" }).click();
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(raw);
    await page.keyboard.press("Escape");
    await header.click();
  }
  expect(unexpectedLoads).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  emit({ type: "completed" });
  await context.close();
});
