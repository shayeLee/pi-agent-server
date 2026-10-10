import { test, expect, type Page, type Route } from "@playwright/test";

const sessionId = "steering-abort-fixture";
const requestId = "active-request-fixture";
const original = "未消费的插话：请先检查边界条件";
const newer = "用户后来输入的新草稿，不能覆盖";
const waiting = "HTTP 已接收，等待消费确认";
type Control = { text: string; controlId: string; acknowledgementId: string; requestId: string };

// All API traffic is intercepted, independent of the configured origin/port.
// A finite SSE response is followed by a held reconnect, released by emit().
async function fixture(page: Page, options: { delayed202?: boolean; abortFails?: boolean } = {}) {
  let eventId = 0;
  let frames: object[] = [{ type: "status", phase: "agent_start", requestId }];
  let stream: Route | undefined;
  let admission: Route | undefined;
  let captured: Control | undefined;
  const controls: Control[] = [];
  let aborts = 0;
  const unexpected: string[] = [];
  const flush = async () => {
    if (!stream || !frames.length) return;
    const route = stream; stream = undefined;
    const body = frames.map(event => `id: ${++eventId}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    frames = [];
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  };
  await page.route("**/v1/**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, json: body });
    if (req.method() === "GET") {
      if (path === "/v1/access") return json({ canRead: true, canWrite: true });
      if (path === "/v1/projects") return json([{ id: "fixture-project", name: "回归隔离项目", cwd: "/fixture", isDefault: true }]);
      if (path === "/v1/models") return json({ models: [], thinkingLevels: ["off"], defaultModel: null, defaultThinkingLevel: "off" });
      if (path === "/v1/sessions") return json([{ id: sessionId, projectId: "fixture-project", title: "插话中止回归", createdAt: 1, updatedAt: 1,
        modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null }]);
      if (path === `/v1/sessions/${sessionId}/export`) return json({ messages: [], timeline: [], lastEventId: 0 });
      if (path === `/v1/sessions/${sessionId}/events`) { stream = route; await flush(); return; }
    }
    if (req.method() === "POST" && path === `/v1/sessions/${sessionId}/steer`) {
      captured = req.postDataJSON();
      controls.push(captured!);
      if (options.delayed202) { admission = route; return; }
      return route.fulfill({ status: 202, body: "" });
    }
    if (req.method() === "POST" && path === `/v1/sessions/${sessionId}/abort`) {
      aborts++;
      return options.abortFails
        ? route.fulfill({ status: 500, json: { error: "fixture abort failed" } })
        : route.fulfill({ status: 204 });
    }
    unexpected.push(`${req.method()} ${path}`);
    await route.fulfill({ status: 501, json: { error: "Unexpected fixture API" } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByTestId(`session-${sessionId}`).click();
  await expect(page.getByTestId("abort-button")).toBeVisible();
  const input = page.getByTestId("composer-input");
  const pending = page.getByTestId("composer-pending-controls");
  await input.fill(original);
  await input.press("Enter");
  await expect.poll(() => captured).toBeDefined();
  expect(captured).toMatchObject({ text: original, requestId, controlId: expect.any(String), acknowledgementId: expect.any(String) });
  expect(captured!.controlId.length).toBeGreaterThan(0);
  expect(captured!.acknowledgementId.length).toBeGreaterThan(0);
  if (!options.delayed202) await expect(pending).toContainText(waiting);
  return {
    input, pending, unexpected, controls,
    emit: async (event: object) => { frames.push(event); await flush(); },
    // A reconnect can only happen after the real SSE reader processed the batch.
    drained: async () => { await expect.poll(() => frames.length === 0 && stream !== undefined).toBe(true); },
    abort: async () => {
      const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/abort") && r.request().method() === "POST");
      await page.getByTestId("abort-button").click();
      expect((await response).status()).toBe(options.abortFails ? 500 : 204);
      expect(aborts).toBe(1);
    },
    release202: async () => { expect(admission).toBeDefined(); await admission!.fulfill({ status: 202, body: "" }); },
    consumed: () => ({ type: "steering_consumed", requestId: captured!.requestId, controlId: captured!.controlId, acknowledgementId: captured!.acknowledgementId }),
  };
}

for (const editDraft of [false, true]) test(`confirmed abort clears pending and preserves ${editDraft ? "newer" : "unconsumed"} draft`, async ({ page }, info) => {
  const f = await fixture(page);
  if (editDraft) await f.input.fill(newer);
  await page.screenshot({ path: info.outputPath("before-abort.png"), fullPage: true });
  await f.abort();
  // HTTP success is admission, not proof of terminal cancellation.
  await expect(f.pending).toContainText(waiting);
  await f.emit({ type: "aborted", requestId: "foreign-request" });
  await expect(page.getByTestId("abort-button")).toBeVisible();
  await expect(f.pending).toContainText(waiting);
  await f.emit({ type: "aborted", requestId });
  await expect(page.getByTestId("abort-button")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("after-abort.png"), fullPage: true });
  await expect(f.pending).toHaveCount(0);
  await expect(f.input).toHaveValue(editDraft ? newer : original);
  if (editDraft) {
    await f.emit(f.consumed());
    await f.drained();
    await expect(f.input).toHaveValue(newer);
    await expect(f.pending).toHaveCount(0);
  }
  expect(f.unexpected).toEqual([]);
});

test("late HTTP 202 cannot resurrect an aborted pending control", async ({ page }, info) => {
  const f = await fixture(page, { delayed202: true });
  await f.input.fill(newer);
  await page.screenshot({ path: info.outputPath("before-abort.png"), fullPage: true });
  await f.abort();
  await f.emit({ type: "aborted", requestId });
  await expect(page.getByTestId("abort-button")).toHaveCount(0);
  await expect(f.pending).toHaveCount(0);
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/steer"));
  await f.release202();
  const accepted = await response;
  expect(accepted.status()).toBe(202);
  await f.drained();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(f.pending).toHaveCount(0);
  await expect(f.input).toHaveValue(newer);
  await page.screenshot({ path: info.outputPath("after-late-202.png"), fullPage: true });
  expect(f.unexpected).toEqual([]);
});

for (const terminal of ["aborted", "completed", "error"] as const) test(`${terminal} respects deleted draft and attachments, releases dedup lock`, async ({ page }, info) => {
  const f = await fixture(page);
  await f.input.fill("");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
  await page.getByTestId("composer-file-input").setInputFiles({ name: "retained.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
  await f.emit({ type: terminal, requestId, ...(terminal === "error" ? { message: "任务明确失败" } : {}) });
  await expect(page.getByTestId("abort-button")).toHaveCount(0);
  await expect(f.pending).toHaveCount(0);
  await expect(f.input).toHaveValue("");
  await expect(page.getByTestId("composer-attachment")).toContainText("retained.png");
  await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
  await page.screenshot({ path: info.outputPath("after-terminal-cleared-draft.png"), fullPage: true });
  // Only the user removes the attachment. Identical text is eligible for a new control.
  await page.getByRole("button", { name: "移除附件 retained.png", exact: true }).click();
  await f.emit({ type: "status", phase: "agent_start", requestId: "next-request" });
  await expect(page.getByTestId("abort-button")).toBeVisible();
  await f.input.fill(original);
  await f.input.press("Enter");
  await expect.poll(() => f.controls.length).toBe(2);
  expect(f.controls[1]).toMatchObject({ text: original, requestId: "next-request" });
  expect(f.controls[1].controlId).not.toBe(f.controls[0].controlId);
  expect(f.controls[1].acknowledgementId).not.toBe(f.controls[0].acknowledgementId);
  await expect(f.pending).toContainText(waiting);
  expect(f.unexpected).toEqual([]);
});

test("failed abort HTTP keeps pending consumption and draft", async ({ page }, info) => {
  const f = await fixture(page, { abortFails: true });
  await page.screenshot({ path: info.outputPath("before-abort.png"), fullPage: true });
  await f.abort();
  await expect(page.getByTestId("abort-button")).toBeVisible();
  await expect(f.pending).toContainText(waiting);
  await expect(f.input).toHaveValue(original);
  await page.screenshot({ path: info.outputPath("after-failed-abort.png"), fullPage: true });
  expect(f.unexpected).toEqual([]);
});
