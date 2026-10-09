import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { test, expect } from "@playwright/test";

const output = "/tmp/web-long-session-performance";
const projectId = "perf-project";
const sessions = [100, 1000, 2000].map(n => ({ id: `perf-${n}`, projectId, title: `Synthetic ${n}`, createdAt: n, updatedAt: n, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null }));
let count = 100;
let eventId = 0;
const streams = new Set<ServerResponse>();
function emit(event: unknown) { for (const stream of streams) stream.write(`id: ${++eventId}\ndata: ${JSON.stringify(event)}\n\n`); }
function history(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const id = `row-${i}`;
    switch (i % 4) {
      case 0: return [{ type: "message", id, role: "user", text: `Synthetic prompt ${i}` }];
      case 1: return [{ type: "message", id, role: "assistant", text: `## Answer ${i}\n\n**Safe markdown** with [fixture link](#fixture), table and code.\n\n|A|B|\n|-|-|\n|one|two|\n\n\`\`\`typescript\nconst value${i} = { count: ${i}, ok: true };\n\`\`\`\n\n- item one\n- item two` }];
      case 2: return [{ type: "thinking", id, text: `Reasoning ${i}\n\nChecking synthetic constraints.` }];
      default: return [{ type: "tool_call", id, toolCallId: id, toolName: "bash", args: { command: `echo synthetic-${i}` } }, { type: "tool_result", id: `${id}-result`, toolCallId: id, result: { content: [{ type: "text", text: `Synthetic output ${i}\n` + "line of output\n".repeat(30) }] }, durationMs: 25 }];
    }
  }).flat();
}
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://fixture").pathname;
  const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === "/v1/access") return json({ canRead: true, canWrite: true });
  if (path === "/v1/projects") return json([{ id: projectId, name: "Synthetic only", cwd: "/fixture", isDefault: true }]);
  if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
  if (path === "/v1/sessions") return json(sessions);
  if (path.endsWith("/export")) return json({ lastEventId: 0, messages: [], timeline: history(Number(path.split("/")[3]?.split("-")[1]) || count) });
  if (path.endsWith("/events")) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.flushHeaders(); streams.add(res);
    req.on("close", () => streams.delete(res)); return;
  }
  json({});
});
test.beforeAll(async () => { await mkdir(output, { recursive: true }); await new Promise<void>(resolve => server.listen(8119, "127.0.0.1", resolve)); });
test.afterAll(async () => { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as any;
    w.__perfCounts = {}; w.__perfCommits = []; w.__perfTasks = []; w.__perfInputs = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) w.__perfTasks.push({ at: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: true });
    document.addEventListener("input", () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => w.__perfInputs.push(performance.now() - start))); }, true);
  });
});

test("synthetic App typing, idle and live mixed SSE", async ({ page, browser }) => {
  const measurements: unknown[] = [];
  for (count of [100, 1000, 2000]) {
    await page.goto("/");
    await page.getByText(`Synthetic ${count}`, { exact: true }).click();
    await expect(page.getByTestId("message-list").locator(":scope > *")).toHaveCount(count);
    await expect(page.getByTestId("composer-input")).toBeEnabled();
    await expect.poll(() => streams.size).toBeGreaterThan(0);
    await page.waitForTimeout(700);
    for (const streaming of [false, true]) {
      let timer: ReturnType<typeof setInterval> | undefined;
      if (streaming) {
        emit({ type: "status", phase: "agent_start", requestId: "perf-stream" });
        emit({ type: "tool_start", toolCallId: "live-tool", toolName: "bash", args: { command: "echo stream" }, requestId: "perf-stream" });
        let tick = 0;
        timer = setInterval(() => {
          tick++;
          emit({ type: "thinking_delta", text: `Thinking ${tick}.\n`, requestId: "perf-stream" });
          emit({ type: "text_delta", text: `Streaming ${tick}.\n`, requestId: "perf-stream" });
          emit({ type: "tool_update", toolCallId: "live-tool", toolName: "bash", partialResult: `Output ${tick}`, requestId: "perf-stream" });
        }, 120);
      }
      const input = page.getByTestId("composer-input");
      await input.fill(""); await input.focus();
      await page.evaluate(() => { const w = globalThis as any; w.__perfCounts = {}; w.__perfCommits = []; w.__perfTasks = []; w.__perfInputs = []; });
      const start = await page.evaluate(() => performance.now());
      await input.pressSequentially("typing fixture!!", { delay: 35 });
      await expect(input).toHaveValue("typing fixture!!");
      await page.waitForTimeout(300);
      if (timer) clearInterval(timer);
      const measurement = await page.evaluate(({ count, streaming, start }) => {
        const w = globalThis as any;
        return { count, streaming, start, end: performance.now(), domNodes: document.querySelectorAll("*").length, counts: w.__perfCounts, commits: w.__perfCommits, longTasks: w.__perfTasks, inputToTwoRafMs: w.__perfInputs };
      }, { count, streaming, start });
      measurements.push(measurement);
      if (!streaming && process.env.PERF_LABEL !== "before") {
        expect(measurement.counts.App ?? 0).toBe(0);
        expect(measurement.counts.Markdown ?? 0).toBe(0);
        expect(measurement.counts.ToolCallCard ?? 0).toBe(0);
      }
      await page.screenshot({ path: `${output}/${process.env.PERF_LABEL ?? "run"}-${process.env.PERF_MODE ?? "prod"}-${count}-${streaming ? "stream" : "idle"}.png` });
      if (streaming) emit({ type: "completed", requestId: "perf-stream" });
    }
  }
  await writeFile(`${output}/${process.env.PERF_LABEL ?? "run"}-${process.env.PERF_MODE ?? "prod"}.json`, JSON.stringify({ hardware: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryBytes: os.totalmem() }, browser: browser.version(), viewport: { width: 1440, height: 900 }, measurements }, null, 2));
});

test("draft scopes, immutable retry/steer snapshots and long-history scroll anchors", async ({ page }) => {
  const sends: any[] = [];
  const steers: any[] = [];
  let rejectSend = true;
  const created = { ...sessions[0], id: "perf-created", title: "Created fixture" };
  await page.route("**/v1/sessions", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ json: created });
  });
  await page.route("**/messages", async route => {
    sends.push(route.request().postDataJSON());
    await route.fulfill(rejectSend ? { status: 400, body: "synthetic rejection" } : { json: {} });
  });
  await page.route("**/steer", async route => { steers.push(route.request().postDataJSON()); await route.fulfill({ json: {} }); });
  await page.goto("/");
  const input = page.getByTestId("composer-input");
  await expect(input).toBeEnabled();
  await input.fill("new scope draft");
  await page.getByText("Synthetic 2000", { exact: true }).click();
  await expect(page.getByTestId("message-list").locator(":scope > *")).toHaveCount(2000);
  await input.fill("long scope draft");
  await page.getByTestId("new-session").click();
  await expect(input).toHaveValue("new scope draft");
  await page.getByText("Synthetic 2000", { exact: true }).click();
  await expect(input).toHaveValue("long scope draft");
  const body = page.getByTestId("chat-body");
  const gap = () => body.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(gap).toBeLessThan(2);
  await body.focus(); await body.press("Home");
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(0);
  const tool = page.getByTestId("tool-call-card").first();
  const toggle = tool.locator(".tool-call-header");
  const anchor = (await toggle.boundingBox())!.y;
  await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect((await toggle.boundingBox())!.y).toBeCloseTo(anchor, 0);
  const lockedTop = await body.evaluate(el => el.scrollTop);
  await expect.poll(() => streams.size).toBeGreaterThan(0);
  emit({ type: "status", phase: "agent_start", requestId: "perf-live" });
  emit({ type: "thinking_delta", text: "Visible live reasoning", requestId: "perf-live" });
  emit({ type: "text_delta", text: "Live output", requestId: "perf-live" });
  await expect(body).toContainText("Live output");
  expect(await body.evaluate(el => el.scrollTop)).toBeCloseTo(lockedTop, 0);
  await input.fill("typing while away");
  expect(await body.evaluate(el => el.scrollTop)).toBeCloseTo(lockedTop, 0);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: `${output}/regression-scroll-tool-anchor.png` });
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect.poll(gap).toBeLessThan(2);
  emit({ type: "text_delta", text: "\n\nFollow another output", requestId: "perf-live" });
  await expect(body).toContainText("Follow another output");
  await expect.poll(gap).toBeLessThan(2);
  emit({ type: "completed", requestId: "perf-live" });
  await expect(page.getByTestId("send-button")).toBeVisible();

  await page.getByTestId("new-session").click();
  await input.fill("original snapshot");
  await page.getByTestId("composer-file-input").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64") });
  await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("retry-submission")).toBeVisible();
  expect(sends).toHaveLength(1);
  expect(sends[0].prompt).toBe("original snapshot");
  expect(sends[0].images).toHaveLength(1);
  await input.fill("newer draft must survive");
  rejectSend = false;
  await page.getByTestId("retry-submission").click();
  await expect(page.getByTestId("retry-submission")).toHaveCount(0);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  await expect(input).toHaveValue("newer draft must survive");
  await expect(page.getByTestId("composer-attachment")).toHaveCount(0);
  await expect.poll(() => streams.size).toBeGreaterThan(0);
  const requestId = sends[0].requestId;
  emit({ type: "status", phase: "agent_start", requestId });
  await expect(page.getByRole("button", { name: "插话", exact: true })).toBeVisible();
  await input.fill("steer snapshot");
  await page.getByRole("button", { name: "插话", exact: true }).click();
  await expect.poll(() => steers.length).toBe(1);
  await expect(input).toHaveValue("steer snapshot");
  await input.fill("after steer typing");
  emit({ type: "steering_consumed", controlId: steers[0].controlId, acknowledgementId: steers[0].acknowledgementId, requestId });
  await expect(page.getByTestId("composer-pending-controls")).toHaveCount(0);
  await expect(input).toHaveValue("after steer typing");
  await page.screenshot({ path: `${output}/regression-draft-retry-steer.png` });
});
