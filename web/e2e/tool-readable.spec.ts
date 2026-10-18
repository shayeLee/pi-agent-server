import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

let server: Server;
let stream: ServerResponse | undefined;
let eventId = 0;
const projectId = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const session = { id: "00000000-0000-4000-8000-000000000096", projectId, title: "工具可读隔离测试", createdAt: 1, updatedAt: 1,
  modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
const singleTask = "核对原始参数\n保留全部提示词，不调用真实模型。";
const tasks = [{ agent: "scout", task: "查找组件\n报告路径", cwd: "/fixture/scout" }, { agent: "worker", task: "验证任务\n" + "long-token-".repeat(35) }];
const waitText = "2/2 background subagent(s) finished.\n\n### [scout] run r2 — completed\n\n组件路径：fixture.tsx\n\n---\n\n### [worker] run r3 — completed\n\n验证结果：通过\n完整末行";
function emit(value: unknown) { stream?.write(`id: ${++eventId}\ndata: ${JSON.stringify(value)}\n\n`); }
function start(id: string, toolName: string, args: unknown) { emit({ type: "tool_start", toolCallId: id, toolName, args }); }
function end(id: string, toolName: string, text: string) { emit({ type: "tool_end", toolCallId: id, toolName,
  result: { content: [{ type: "text", text }], details: { fixture: { unknown: [false, 0] } } }, isError: false }); }

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: projectId, name: "隔离工具测试", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions") return req.method === "POST" ? json(session, 201) : json([]);
    if (path === `/v1/sessions/${session.id}/control-queue`) return json({ requestId: null, revision: 0, items: [] });
    if (path.endsWith("/export")) return json({ lastEventId: 0, messages: [], timeline: [] });
    if (path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders(); stream = res;
      req.on("close", () => { if (stream === res) stream = undefined; }); return;
    }
    if (path.endsWith("/messages")) {
      req.resume();
      setTimeout(() => {
        start("ordinary", "bash", { command: "printf fixture", options: { flags: [false, 0] } });
        end("ordinary", "bash", "普通工具最终正文");
        start("single", "subagent", { agent: "worker", task: singleTask, cwd: "/fixture" });
        end("single", "subagent", "Background subagent started (runId: r1, agent: worker). Call subagent_wait to collect its result.");
        start("parallel", "subagent", { tasks, agentScope: "both" });
        end("parallel", "subagent", "2 background subagent(s) started:\n  runId: r2 — scout\n  runId: r3 — worker\n\nCall subagent_wait (with no arguments) to collect all of their results.");
        start("wait", "subagent_wait", { runIds: ["r2", "r3"], timeoutMs: 600000 });
        emit({ type: "tool_update", toolCallId: "wait", toolName: "subagent_wait", partialResult: { content: [{ type: "text", text: "0/2 settled" }] } });
      }, 100);
      return json({ status: "accepted" }, 202);
    }
    json({ error: `Unexpected fixture path ${path}` }, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8122, "127.0.0.1", resolve); });
});
test.afterAll(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

test("通用参数优先、真实快照替换、手动键盘折叠保留、明暗桌面手机", async ({ page }) => {
  await mkdir("/tmp/subagent-tool-readable", { recursive: true });
  await page.goto("/");
  await page.getByTestId("composer-input").fill("隔离工具展示");
  await page.getByTestId("send-button").click();
  const cards = page.getByTestId("tool-call-card");
  await expect(cards).toHaveCount(4);
  for (const card of await cards.all()) {
    const header = card.locator(".tool-call-header");
    const done = await card.getAttribute("data-done") === "true";
    // Running tools open on their own, except subagent_wait (the live subagent panel shows its progress).
    const wait = await card.getAttribute("data-tool-call-id") === "wait";
    await expect(header).toHaveAttribute("aria-expanded", String(!done && !wait));
    if (done || wait) await header.click();
  }
  const wait = page.locator('[data-tool-call-id="wait"]');
  await expect(wait.getByTestId("tool-result-text")).toHaveText("0/2 settled");
  const header = wait.locator(".tool-call-header");
  await header.focus(); await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  emit({ type: "tool_update", toolCallId: "wait", toolName: "subagent_wait", partialResult: { content: [{ type: "text", text: "1/2 settled" }] } });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(wait.getByTestId("tool-result-text")).toHaveText("1/2 settled");
  end("wait", "subagent_wait", waitText); emit({ type: "completed" });
  await expect(wait).toHaveAttribute("data-done", "true");
  // The turn ended, so its work block folded; open it to reach the step.
  const block = page.locator('.work-header').last();
  if (await block.getAttribute("aria-expanded") === "false") await block.click();
  await header.click();
  await expect(wait).toHaveAttribute("data-done", "true");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(wait.locator('.tool-call-body > :not(section)')).toHaveCount(0);
  await expect(wait.getByRole("heading", { name: "[scout] run r2 — completed" })).toBeVisible();
  await wait.getByRole("button", { name: "Markdown 展示" }).click();
  await expect(wait.getByRole("region", { name: "结果", exact: true }).locator(".tool-readable-value")).toHaveText(waitText);
  await wait.getByRole("button", { name: "Markdown 展示" }).click();
  await expect(wait.getByTestId("tool-result-text")).not.toContainText("settled");
  const singleTaskSource = page.locator('[data-tool-call-id="single"] .tool-subagent-task > pre');
  await expect(singleTaskSource).toBeVisible();
  expect(await singleTaskSource.textContent()).toBe(singleTask);
  await expect(page.locator('[data-tool-call-id="parallel"]').getByRole("list", { name: "代理任务" }).locator(":scope > li")).toHaveCount(2);
  await expect(cards.first().getByTestId("tool-result-text").locator('.code-block[data-language="bash"] pre')).toHaveText("普通工具最终正文");
  expect(await cards.evaluateAll(elements => elements.map(el => el.getAttribute("data-tool-call-id")))).toEqual(["ordinary", "single", "parallel", "wait"]);
  for (const card of await cards.all()) {
    await expect(card.locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
    expect(await card.locator(".tool-call-body").evaluate(el => Array.from(el.children).filter(child => child.tagName === "SECTION").map(child => child.getAttribute("aria-label")))).toEqual(["参数", "结果"]);
  }
  for (const theme of ["dark", "light"]) {
    for (const width of [1400, 390]) {
      await page.setViewportSize({ width: 1400, height: 1000 });
      if (await page.getByTestId("app").getAttribute("data-theme") !== theme) {
        await page.getByTestId("settings-toggle").click();
        await page.getByRole("menuitemradio", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
      }
      await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.waitForTimeout(250); // Let the responsive sidebar transition settle before captures.
      await cards.first().scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390) expect(await header.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `/tmp/subagent-tool-readable/${theme}-${width}-calls.png` });
      await page.locator('[data-tool-call-id="parallel"]').getByRole("list", { name: "代理任务" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/subagent-tool-readable/${theme}-${width}-parallel.png` });
      await wait.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/subagent-tool-readable/${theme}-${width}-result.png` });
      expect(await wait.locator("button button").count()).toBe(0);
    }
  }
  expect(await page.locator('[data-tool-call-id="parallel"] .tool-subagent-task > pre').last().textContent()).toBe(tasks[1].task);
  await header.focus(); await page.keyboard.press("Enter");
  emit({ type: "tool_end", toolCallId: "wait", toolName: "subagent_wait", result: "Wait aborted", isError: true });
  await expect(wait).toHaveClass(/tool-error/);
  await expect(header).toHaveAttribute("aria-expanded", "false");
});
