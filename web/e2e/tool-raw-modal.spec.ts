import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
let server: Server, stream: ServerResponse | undefined;
let eventId = 0;
const projectId = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const session = { id: "00000000-0000-4000-8000-000000000107", projectId, title: "原始数据隔离验证", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
const emit = (data: unknown) => stream?.write(`id: ${++eventId}\ndata: ${JSON.stringify(data)}\n\n`);
test.beforeAll(async () => {
  await mkdir("/tmp/tool-raw-modal", { recursive: true });
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: projectId, name: "隔离 Modal", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions") return json(req.method === "POST" ? session : [], req.method === "POST" ? 201 : 200);
    if (path.endsWith("/export")) return json({ lastEventId: 0, messages: [], timeline: [] });
    if (path.endsWith("/events")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); stream = res; req.on("close", () => { if (stream === res) stream = undefined; }); return; }
    if (path.endsWith("/messages")) { req.resume(); return json({ status: "accepted" }, 202); }
    return json({ error: path }, 404);
  });
  await new Promise<void>(resolve => server.listen(8107, "127.0.0.1", resolve));
});
test.afterAll(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
// Business flow representatives: light desktop and dark mobile, not the full cross-product.
for (const { theme, width } of [{ theme: "light", width: 1280 }, { theme: "dark", width: 390 }] as const) {
  test(`${theme} ${width}: native modal, live snapshots, keyboard, copy and scroll`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1280, height: 800 }); await page.goto("/");
    if (await page.getByTestId("app").getAttribute("data-theme") !== theme) await page.getByTestId("theme-toggle").click();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.getByTestId("composer-input").fill("检查原始数据"); await page.getByTestId("send-button").click();
    await expect.poll(() => !!stream).toBe(true);
    for (let i = 0; i < 25; i++) {
      emit({ type: "tool_start", toolCallId: `filler-${i}`, toolName: "read", args: { path: `/fixture/file-${i}.ts` } });
      emit({ type: "tool_end", toolCallId: `filler-${i}`, toolName: "read", result: "complete", isError: false });
    }
    const args = { command: "printf '完整原始数据\\n'", zero: 0, flag: false, empty: "", nil: null };
    emit({ type: "tool_start", toolCallId: "raw", toolName: "bash", args });
    emit({ type: "tool_update", toolCallId: "raw", toolName: "bash", partialResult: { snapshot: 1, lines: Array.from({ length: 60 }, (_, i) => `line ${i}`) } });
    const card = page.locator('[data-tool-call-id="raw"]'), header = card.locator('.tool-call-header');
    await expect(header).toHaveAttribute("aria-expanded", "true"); await header.click();
    const more = card.getByRole("button", { name: "工具更多操作" });
    await more.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    const modal = page.getByRole("dialog", { name: "原始数据 · bash" });
    await expect(modal).toBeVisible(); await expect(header).toHaveAttribute("aria-expanded", "false");
    const close = modal.getByRole("button", { name: "关闭对话框" }), source = modal.getByLabel("代码原文");
    await expect(close).toBeFocused(); await page.keyboard.press("Shift+Tab"); await expect(source).toBeFocused();
    await page.keyboard.press("Tab"); await expect(close).toBeFocused();
    await page.getByTestId("composer-input").evaluate(el => (el as HTMLElement).focus()); await expect(close).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    const scrolls = () => page.getByTestId('chat-body').evaluate(el => el.scrollTop);
    expect(await page.getByTestId('chat-body').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const before = await scrolls();
    await page.mouse.move(width - 2, 200); await page.mouse.wheel(0, -600); await page.waitForTimeout(100); expect(await scrolls()).toEqual(before);
    await modal.locator('.modal-body').evaluate(el => { el.scrollTop = 200; });
    await expect(close).toBeInViewport();
    await modal.locator('.modal-body').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/tool-raw-modal/${theme}-${width}.png` });
    const box = (await modal.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(12); expect(box.x + box.width).toBeLessThanOrEqual(width - 12);
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Drag across either boundary must not dismiss.
    await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(2, 2); await page.mouse.up(); await expect(modal).toBeVisible();
    await page.mouse.move(2, 2); await page.mouse.down(); await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.up(); await expect(modal).toBeVisible();
    emit({ type: "tool_update", toolCallId: "raw", toolName: "bash", partialResult: false });
    await expect(source).toContainText('"partialResult": false'); await expect(source).not.toContainText('"snapshot"');
    emit({ type: "tool_end", toolCallId: "raw", toolName: "bash", result: null, isError: false }); emit({ type: "completed" });
    await expect(modal).toBeVisible(); await expect(source).toContainText('"resultKind": "final"');
    const full = (await source.textContent())!;
    expect(JSON.parse(full)).toEqual({ argsProvided: true, args, resultKind: "final", resultProvided: true, result: null });
    await modal.getByRole("button", { name: "复制原始数据" }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(full);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
    await modal.getByRole("button", { name: "复制原始数据" }).click(); await expect(modal.getByRole("status")).toContainText("复制失败");
    await page.keyboard.press("Escape"); await expect(modal).not.toBeVisible(); await expect(more).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(""); expect(await scrolls()).toEqual(before);
    await page.mouse.move(width - 20, 200); await page.mouse.wheel(0, -300);
    await expect.poll(scrolls).toBeLessThan(before);
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await more.click(); await card.getByRole("menuitem", { name: "查看原始数据" }).click(); await page.mouse.click(2, 2); await expect(modal).not.toBeVisible(); await expect(more).toBeFocused();
    // Long names are readable, not ellipsized; structured fallback uses the same modal.
    const longName = "custom_" + "very_long_tool_name_".repeat(8);
    emit({ type: "tool_start", toolCallId: "long", toolName: longName, args: {} });
    emit({ type: "tool_update", toolCallId: "long", toolName: longName, partialResult: { unknown: true } });
    const longCard = page.locator('[data-tool-call-id="long"]');
    await longCard.getByRole("button", { name: "查看原始数据", exact: true }).click();
    const longModal = page.getByRole("dialog", { name: `原始数据 · ${longName}` }); await expect(longModal).toBeVisible();
    await page.screenshot({ path: `/tmp/tool-raw-modal/${theme}-${width}-long-title.png` });
    emit({ type: "tool_end", toolCallId: "long", toolName: longName, result: 0, isError: true });
    await expect(longCard.locator('.tool-call-header')).toHaveAttribute("aria-expanded", "false"); await expect(longModal).toBeVisible();
    await longModal.getByRole("button", { name: "关闭对话框" }).click(); await expect(longCard.getByRole("button", { name: "工具更多操作" })).toBeFocused();
  });
}
