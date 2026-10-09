import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
let server: Server;
let stream: ServerResponse | undefined;
const session = { id: "00000000-0000-4000-8000-000000000098", projectId: "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c", title: "折叠实时工具", createdAt: 1, updatedAt: 1, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null };
let eventId = 0;
const emit = (value: unknown) => stream!.write(`id: ${++eventId}\ndata: ${JSON.stringify(value)}\n\n`);
const result = (text: string, details?: unknown) => ({ content: [{ type: "text", text }], details });
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/v1/access") return json({ canRead: true, canWrite: true });
    if (path === "/v1/projects") return json([{ id: session.projectId, name: "隔离 mock", cwd: "/fixture", isDefault: true }]);
    if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
    if (path === "/v1/sessions") return req.method === "POST" ? json(session, 201) : json([]);
    if (path.endsWith("/export")) return json({ lastEventId: 0, messages: [], timeline: [] });
    if (path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.flushHeaders(); stream = res;
      req.on("close", () => { if (stream === res) stream = undefined; }); return;
    }
    if (path.endsWith("/messages")) { req.resume(); return json({ status: "accepted" }, 202); }
    json({ error: path }, 404);
  });
  await new Promise<void>(resolve => server.listen(8098, "127.0.0.1", resolve));
});
test.afterAll(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
test("actual SSE: collapsed bash/wait snapshots, child semantics, previews, preference and responsive themes", async ({ page }) => {
  await mkdir("/tmp/tool-collapsed-single-line", { recursive: true });
  await mkdir("/tmp/tool-auto-expand", { recursive: true });
  await page.goto("/");
  await page.getByTestId("composer-input").fill("isolated fixture");
  await page.getByTestId("send-button").click();
  await expect.poll(() => Boolean(stream)).toBe(true);
  await mkdir("/tmp/expanded-header-preview", { recursive: true });
  emit({ type: "thinking_delta", text: "检查 header 预览来源\n" + "长思考内容".repeat(30) });
  const thinkingHeader = page.locator(".thinking-header");
  await expect(thinkingHeader).toHaveAttribute("aria-expanded", "true");
  const thinkingPreview = await thinkingHeader.locator(".thinking-summary").textContent();
  await thinkingHeader.click();
  await expect(thinkingHeader.locator(".thinking-summary")).toHaveText(thinkingPreview!);
  await thinkingHeader.click();
  await expect(thinkingHeader.locator(".thinking-summary")).toHaveText(thinkingPreview!);
  const card = (id: string) => page.locator(`[data-tool-call-id="${id}"]`);
  const start = (id: string, name: string, args: unknown) => emit({ type: "tool_start", toolCallId: id, toolName: name, args });
  const update = (id: string, name: string, text: string) => emit({ type: "tool_update", toolCallId: id, toolName: name, partialResult: result(text) });
  const end = (id: string, name: string, text: string, details?: unknown, isError = false) => emit({ type: "tool_end", toolCallId: id, toolName: name, result: result(text, details), isError });
  // No header interaction: real tool_start/update/end controls the default lifecycle.
  start("auto", "bash", { command: "printf 'stream snapshots'" });
  await expect(card("auto").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
  for (const text of ["first snapshot\n", "first snapshot\nlatest snapshot\n"]) {
    update("auto", "bash", text);
    await expect(card("auto").getByTestId("tool-result-text").locator("pre")).toHaveText(text);
    expect(await card("auto").getByTestId("tool-result-text").locator("pre").textContent()).toBe(text);
    await expect(card("auto")).toHaveAttribute("data-done", "false");
  }
  for (const theme of ["dark", "light"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    if (await page.getByTestId("app").getAttribute("data-theme") !== theme) await page.getByTestId("theme-toggle").click();
    await page.setViewportSize({ width, height: 844 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("app")).not.toHaveClass(/mobile-sidebar-open/);
    await page.waitForTimeout(300); // Let the existing responsive sidebar transition settle before capture.
    await expect(card("auto").getByTestId("tool-result-text")).toBeVisible();
    for (const expanded of [true, false]) {
      const header = card("auto").locator(".tool-call-header");
      const before = await header.boundingBox();
      const thinkingBefore = await thinkingHeader.boundingBox();
      const preview = await header.locator(".tool-summary-preview").textContent();
      await page.screenshot({ path: `/tmp/expanded-header-preview/${theme}-${width}-${expanded ? "expanded" : "collapsed"}.png` });
      await header.click();
      await thinkingHeader.click();
      await expect(header.locator(".tool-summary-preview")).toHaveText(preview!);
      await expect(thinkingHeader.locator(".thinking-summary")).toHaveText(thinkingPreview!);
      const after = await header.boundingBox();
      const thinkingAfter = await thinkingHeader.boundingBox();
      expect(after!.width).toBe(before!.width);
      expect(after!.height).toBe(before!.height);
      expect(thinkingAfter!.width).toBe(thinkingBefore!.width);
      expect(thinkingAfter!.height).toBe(thinkingBefore!.height);
      for (const summary of [header.locator(".tool-summary-preview"), thinkingHeader.locator(".thinking-summary")]) {
        expect(await summary.evaluate(el => ({ whiteSpace: getComputedStyle(el).whiteSpace, ellipsis: getComputedStyle(el).textOverflow }))).toEqual({ whiteSpace: "nowrap", ellipsis: "ellipsis" });
      }
    }
    await page.screenshot({ path: `/tmp/tool-auto-expand/${theme}-${width}-running.png` });
  }
  // Screenshot toggles are user interaction; use a fresh untouched tool for auto-close assertions.
  start("untouched", "bash", { command: "printf delayed" });
  await expect(card("untouched").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
  end("untouched", "bash", "finished");
  await expect(card("untouched").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "false");
  await card("auto").locator(".tool-call-header").click();
  const finalText = "final result\n  exact original\n\n";
  end("auto", "bash", finalText);
  await expect(card("auto").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "false");
  await expect(card("auto").locator(".tool-call-body")).toHaveCount(0);
  await expect(card("auto").locator(".tool-summary-preview")).toContainText("exact original");
  await page.screenshot({ path: "/tmp/tool-auto-expand/light-mobile-ended.png" });
  await card("auto").locator(".tool-call-header").click();
  expect(await card("auto").getByTestId("tool-result-text").locator("pre").textContent()).toBe(finalText);
  await page.screenshot({ path: "/tmp/tool-auto-expand/light-mobile-manual-final.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  const bashCommand = "printf 'first\\nsecond\\n' && echo '" + "very-long-command ".repeat(30) + "'\n# preserved second command line";
  start("bash", "bash", { command: bashCommand, timeout: 0 });
  await expect(card("bash").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
  await card("bash").locator(".tool-call-header").click(); // User explicitly chooses a collapsed stream.
  for (const text of ["first\n", "first\nsecond\n\n"]) {
    update("bash", "bash", text);
    await expect(card("bash").locator(".tool-summary-preview")).toContainText(text.includes("second") ? "second" : "first");
    await expect(card("bash").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "false");
    await expect(card("bash").locator(".tool-call-body")).toHaveCount(0);
  }
  await page.screenshot({ path: "/tmp/tool-collapsed-single-line/bash-second.png" });
  end("bash", "bash", "final\n");
  start("launch", "subagent", { tasks: [{ agent: "scout", task: "inspect\nfull prompt", cwd: "/one" }, { agent: "worker", task: "implement " + "long ".repeat(60), cwd: "/two" }] });
  end("launch", "subagent", "Background subagents started (runIds: r1, r2).", { liveRunIds: ["r1", "r2"], results: [] });
  await expect(card("launch").locator(".tool-parallel-count")).toHaveText("并行 2");
  await expect(card("launch").locator(".tool-parallel-names")).toHaveText("scout、worker");
  await expect(card("launch").locator(".tool-parallel-preview")).toContainText("inspect full prompt · implement");
  await expect(card("launch").locator(".tool-summary-preview")).not.toContainText("completed");
  await expect(card("launch").getByRole("img", { name: "已完成" })).toBeVisible();
  start("wait", "subagent_wait", { runIds: ["r1", "r2"] });
  await expect(card("wait").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
  await card("wait").locator(".tool-call-header").click();
  for (const text of ["0/2 settled after 1s\nrun r1 (scout): reading\nrun r2 (worker): starting", "1/2 settled after 2s\nrun r2 (worker): testing"]) {
    update("wait", "subagent_wait", text);
    await expect(card("wait").locator(".tool-summary-preview")).toContainText(text.startsWith("0/") ? "0/2 settled after 1s" : "1/2 settled after 2s");
    await expect(card("wait").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "false");
    await expect(card("wait").locator(".tool-call-body")).toHaveCount(0);
  }
  await expect(card("wait").locator(".tool-summary-preview")).not.toContainText("reading");
  await page.screenshot({ path: "/tmp/tool-collapsed-single-line/wait-updated.png" });
  end("wait", "subagent_wait", "Waited 2s: 1/2 finished, 1 still running.\n\n### [scout] run r1 — failed\nreal child failure", { results: [{ agent: "scout", exitCode: 1 }] });
  await expect(card("wait").locator(".tool-summary-preview")).toContainText("still running");
  await expect(card("wait").getByRole("img", { name: "已完成" })).toBeVisible();
  const snapshots = [
    ["single", "subagent", { agent: "reviewer", task: "review source", cwd: "/tmp" }, "Background subagent started (runId: r3, agent: reviewer).", "reviewer: review source"],
    ["all", "subagent_wait", {}, "No background subagent result is outstanding.", "全部待收集 runs"],
    ["status", "subagent_status", { runId: "r2" }, "r2 worker running", "run: r2"],
    ["logs", "subagent_logs", { runId: "r2", tail: 0 }, "run r2 transcript", "tail: 0"],
    ["steer", "subagent_steer", { runId: "r2", message: "inspect tests" }, "Steering message queued for run r2.", "message: inspect tests"],
    ["stop", "subagent_stop", { runId: "r2" }, "Stop requested for run r2. It exits later.", "run: r2"],
    ["read", "read", { path: "a.ts" }, "const x = 0;", "a.ts"],
    ["write", "write", { path: "a.py", content: 'print("hi")\n' }, "wrote a.py", "a.py"],
    ["edit", "edit", { path: "a.ts", edits: [{ oldText: "x=0", newText: "x=1" }] }, "edited a.ts", "1 项修改"],
    ["unknown", "custom", { flag: false, count: 0 }, "snapshot", "flag: false · count: 0"],
  ] as const;
  for (const [id, name, args, text, preview] of snapshots) {
    start(id, name, args); end(id, name, text);
    await expect(card(id).locator(".tool-summary-preview")).toContainText(preview);
    await expect(card(id).locator(".tool-summary-preview")).toContainText(text);
    const header = card(id).locator(".tool-call-header");
    const layout = await header.evaluate(el => {
      const summary = el.querySelector<HTMLElement>(".tool-summary-preview");
      const style = summary && getComputedStyle(summary);
      return { height: el.getBoundingClientRect().height, whiteSpace: style?.whiteSpace, overflow: style?.textOverflow,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    expect(layout.height).toBe(44);
    expect(layout.whiteSpace).toBe("nowrap");
    expect(layout.overflow).toBe("ellipsis");
    expect(layout.overflowX).toBe(false);
  }
  start("error", "custom", {}); end("error", "custom", "actual tool error", undefined, true);
  await expect(card("error").getByRole("img", { name: "失败" })).toBeVisible();
  emit({ type: "completed" });
  for (const theme of ["dark", "light"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    if (await page.getByTestId("app").getAttribute("data-theme") !== theme) await page.getByTestId("theme-toggle").click();
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.keyboard.press("Escape");
    await expect(page.getByTestId("app")).not.toHaveClass(/mobile-sidebar-open/);
    await page.waitForTimeout(250);
    await page.getByTestId("chat-body").evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `/tmp/tool-collapsed-single-line/${theme}-${width}.png`, fullPage: true });
  }
  await card("launch").locator(".tool-call-header").click();
  await expect(card("launch").locator(".tool-subagent-agent")).toHaveText(["scout", "worker"]);
  await expect(card("launch").locator(".tool-subagent-task").nth(1)).toContainText("long ".repeat(60).trim());
  await card("write").locator(".tool-call-header").click();
  await expect(card("write").locator('[data-language="python"]')).toBeVisible();
  await card("edit").locator(".tool-call-header").click();
  await expect(card("edit").locator(".diff-block")).toBeVisible();
  await card("bash").locator(".tool-call-header").click();
  update("bash", "bash", "ignored stale partial");
  await expect(card("bash").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
  await expect(card("bash").getByTestId("tool-result-text").locator("pre")).toHaveText("final\n");
  await expect(card("bash").getByRole('region', { name: '参数', exact: true }).locator('[data-language="bash"] pre')).toHaveText(bashCommand);
  await card("bash").locator(".tool-call-header").click();
  end("bash", "bash", "latest final");
  await expect(card("bash").locator(".tool-call-header")).toHaveAttribute("aria-expanded", "false");
  await expect(card("bash").locator(".tool-summary-preview")).toContainText("latest final");
});
