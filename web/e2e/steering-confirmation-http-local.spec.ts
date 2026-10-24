import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.js";
import { steeringSdkFixture } from "../../tests/agent/steering-sdk-fixture.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makeTestIpAccess } from "../../tests/helpers/ip-access.js";

test("consumed SDK steering is visible exactly once before assistant, including images and reload", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "pi-steering-browser-"));
  const artifact = mkdtempSync(join(tmpdir(), "steering-visible-"));
  console.log(`Steering artifacts: ${artifact}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("offline fixture blocks non-loopback network");
    return originalFetch(input, init);
  };
  const db = await makeInitializedMemoryDb({ dataDir: root });
  const f = await steeringSdkFixture(root);
  await db.sessions.create({ id: "steering-test", title: "隔离插话确认", ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }),
    projectId: DEFAULT_PROJECT_ID, createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  const app = buildApp({ sessions: db.sessions, projects: db.projects, defaultProjectCwd: root, ipAccess: makeTestIpAccess(), createAdapter: async () => f.adapter });
  const requests: any[] = [];
  const cursors: string[] = [];
  const network: any[] = [];
  const failures: any[] = [];
  let observer: Page | undefined;
  let sdkStreamingAtScreenshot: boolean | undefined;
  const instrument = async (target: Page, windowName: string) => {
  target.on("pageerror", error => failures.push({ window: windowName, error: String(error) }));
  target.on("requestfailed", r => failures.push({ window: windowName, url: r.url(), failure: r.failure() }));
  target.on("request", r => {
    if (r.method() === "POST" && r.headers()["content-type"]?.includes("application/json")) requests.push({ window: windowName, url: r.url(), body: r.postDataJSON() });
    if (/\/v1\/sessions\/[^/]+\/events/.test(r.url())) cursors.push(r.headers()["last-event-id"]);
  });
  target.on("response", r => { if (r.request().method() === "POST") network.push({ window: windowName, url: r.url(), status: r.status() }); });
  await target.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await target.exposeBinding("recordSteeringEvidence", (_source, row) => { network.push({ window: windowName, ...row }); });
  await target.addInitScript(() => {
    const record = (row: any) => (window as any).recordSteeringEvidence(row);
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await fetch(...args);
      const url = String(args[0]);
      if (url.endsWith("/steer") || url.endsWith("/follow-ups")) await record({ url, status: res.status, kind: "admission" });
      if (/\/v1\/sessions\/[^/]+\/events/.test(url) && res.body) {
        await record({ url, status: res.status, contentType: res.headers.get("content-type"), kind: "sse-ready" });
        const reader = res.clone().body!.getReader();
        void (async () => { let pending = ""; const decoder = new TextDecoder();
          try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true }); let end: number;
            while ((end = pending.indexOf("\n\n")) >= 0) { await record({ url, frame: pending.slice(0, end) }); pending = pending.slice(end + 2); }
          } } catch { /* isolation teardown */ }
        })();
      }
      return res;
    };
  });
  };
  await instrument(page, "main");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
  const evidence = async () => network.filter(row => row.window === "main");
  const events = async (windowName = "main") => network.filter(row => row.window === windowName && row.frame).flatMap(row => {
    const data = row.frame.split("\n").find((line: string) => line.startsWith("data: ")); return data ? [JSON.parse(data.slice(6))] : [];
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 5268 });
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
    await page.getByTestId("session-steering-test").click();
    const input = page.getByTestId("composer-input"); await input.fill("你现在在干嘛？"); await input.press("Enter");
    await expect.poll(f.waits).toBe(1);
    await input.fill("你现在在干嘛？");
    await input.press("Enter");
    await expect.poll(async () => (await evidence()).filter(e => e.kind === "admission").map(e => e.status)).toEqual([202]);
    const firstControl = requests.find(r => r.url.endsWith("/follow-ups"))!.body;
    await expect(input).toHaveValue("");
    await expect(page.getByRole("group", { name: "运行时发送模式" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "追加队列", exact: true }).getByTestId("control-queue-item")).toHaveCount(1);
    await page.screenshot({ path: join(artifact, "default-send-followUp.png"), fullPage: true });
    await page.getByRole("button", { name: `引导：${firstControl.text}`, exact: true }).click();
    await expect(page.getByRole("region", { name: "引导队列", exact: true }).getByTestId("control-queue-item")).toHaveCount(1);
    await page.screenshot({ path: join(artifact, "default-send-promoted.png"), fullPage: true });
    await expect(page.getByTestId("control-queue-item")).toContainText(firstControl.text);
    await expect(page.getByTestId("composer-pending-controls")).toHaveCount(0);
    await expect.poll(async () => (await events()).some(e => e.type === "control_queue" && e.requestId === firstControl.requestId && e.items.some((item: any) =>
      item.id === firstControl.controlId && item.acknowledgementId === firstControl.acknowledgementId && item.kind === "steer" && item.status === "queued"))).toBe(true);
    const readQueue = () => page.evaluate(async () => {
      const response = await fetch("/v1/sessions/steering-test/control-queue");
      if (response.status !== 200) throw new Error(`queue HTTP ${response.status}`);
      return response.json();
    });
    expect(await readQueue()).toMatchObject({ requestId: firstControl.requestId, items: [expect.objectContaining({ id: firstControl.controlId, acknowledgementId: firstControl.acknowledgementId, text: firstControl.text })] });
    await input.press("Enter"); // Admission cleared the original follow-up snapshot; empty Enter must not resend.
    expect(requests.filter(r => r.url.endsWith("/follow-ups"))).toHaveLength(1);
    expect(requests.filter(r => r.url.endsWith("/steer"))).toHaveLength(0);
    expect((await events()).filter(e => e.type === "steering_consumed")).toHaveLength(0);
    await page.screenshot({ path: join(artifact, "submitted-waiting-consumption.png"), fullPage: true });
    // Exercise follow-up admission and identity-preserving promotion/deletion against the same real SDK queue.
    await input.fill("完成后追加的隔离任务");
    await page.getByTestId("composer-file-input").setInputFiles({ name: "follow-up.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
    const followResponse = page.waitForResponse(r => r.url().endsWith("/follow-ups") && r.request().method() === "POST");
    await input.press("Enter");
    expect((await followResponse).status()).toBe(202);
    await expect(input).toHaveValue("");
    const follow = requests.filter(r => r.url.endsWith("/follow-ups"))[1]!.body;
    expect(follow).toEqual({ text: "完成后追加的隔离任务", requestId: firstControl.requestId, controlId: expect.any(String), acknowledgementId: expect.any(String), images: [{ mediaType: "image/png", base64: png }] });
    await expect(page.getByTestId("composer-attachment")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "追加队列", exact: true }).getByTestId("control-queue-item")).toHaveCount(1);
    expect(await readQueue()).toMatchObject({ requestId: firstControl.requestId, items: expect.arrayContaining([
      expect.objectContaining({ id: follow.controlId, kind: "followUp", acknowledgementId: follow.acknowledgementId, text: follow.text, hasImages: true }),
    ]) });
    await expect.poll(async () => (await events()).some(e => e.type === "control_queue" && e.items.some((item: any) => item.id === follow.controlId && item.kind === "followUp"))).toBe(true);
    await expect(page.locator(".message-user")).toHaveCount(1); // Neither 202 is consumption.
    await input.fill("队列操作不能覆盖的新草稿");
    const promotion = page.waitForResponse(r => r.url().endsWith(`/control-queue/${follow.controlId}/promote`));
    await page.getByRole("button", { name: `引导：${follow.text}`, exact: true }).click();
    expect((await promotion).status()).toBe(200);
    await expect(page.getByRole("region", { name: "追加队列", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "引导队列", exact: true }).getByTestId("control-queue-item")).toHaveCount(2);
    expect(requests.find(r => r.url.endsWith(`/control-queue/${follow.controlId}/promote`))!.body).toEqual({ requestId: follow.requestId, acknowledgementId: follow.acknowledgementId });
    expect(await readQueue()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: follow.controlId, kind: "steer", acknowledgementId: follow.acknowledgementId, hasImages: true })]) });
    const deletion = page.waitForResponse(r => r.url().endsWith(`/control-queue/${follow.controlId}`) && r.request().method() === "DELETE");
    await page.getByRole("button", { name: `删除：${follow.text}`, exact: true }).click();
    const deleted = await deletion;
    expect(deleted.status()).toBe(200);
    expect(deleted.request().postDataJSON()).toEqual({ requestId: follow.requestId, acknowledgementId: follow.acknowledgementId });
    await expect(page.getByTestId("control-queue-item")).toHaveCount(1);
    expect((await readQueue()).items.map((item: any) => item.id)).toEqual([firstControl.controlId]);
    await expect(input).toHaveValue("队列操作不能覆盖的新草稿");
    await page.screenshot({ path: join(artifact, "default-send-deleted.png"), fullPage: true });
    await input.fill("新草稿不能丢");
    await page.getByTestId("composer-file-input").setInputFiles({ name: "new-draft.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
    // Detach with unresolved admission. SDK consumes in the background, then return with the old cursor.
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    await expect(page.getByTestId("composer-pending-controls")).toHaveCount(0);
    await expect(page.getByTestId("control-queue-item")).toHaveCount(0);
    f.release();
    await expect.poll(f.waits).toBe(2);
    await page.getByTestId("session-steering-test").click();
    await expect(page.getByTestId("composer-pending-controls")).toHaveCount(0);
    await expect(input).toHaveValue("新草稿不能丢");
    await expect(page.getByTestId("composer-attachment")).toContainText("new-draft.png");
    await expect.poll(() => Number(cursors.at(-1))).toBeGreaterThan(0);
    await expect(page.locator(".message-assistant").last()).toContainText("正在写代码，主任务继续。");
    await expect(page.getByTestId("control-queue-item")).toHaveCount(0);
    expect(await readQueue()).toMatchObject({ items: [] });
    // The instrumented clone is read independently of the UI's SSE reader.
    await expect.poll(async () => {
      const rows = await events();
      const consumedIndex = rows.findIndex(e => e.type === "steering_consumed");
      return consumedIndex >= 0 && rows.some((e, i) => i > consumedIndex && e.type === "text_delta");
    }).toBe(true);
    const captured = await events();
    const ack = captured.filter(e => e.type === "steering_consumed"); expect(ack).toHaveLength(1);
    const body = firstControl;
    expect(ack[0]).toMatchObject({ type: "steering_consumed", controlId: body.controlId, acknowledgementId: body.acknowledgementId, requestId: body.requestId,
      message: { sourceId: expect.any(String), text: "你现在在干嘛？" } });
    await expect(page.locator(".message-user")).toHaveCount(2);
    expect(await page.locator(".message-user").last().evaluate(node => {
      const assistants = document.querySelectorAll(".message-assistant");
      const continuation = assistants[assistants.length - 1];
      return !!continuation && !!(node.compareDocumentPosition(continuation) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    expect(captured.findIndex(e => e === ack[0])).toBeLessThan(captured.findIndex((e, i) => i > captured.indexOf(ack[0]) && e.type === "text_delta"));
    expect(captured.some(e => ["completed", "aborted", "error"].includes(e.type))).toBe(false);
    expect(f.session.isStreaming).toBe(true);
    await page.screenshot({ path: join(artifact, "final.png"), fullPage: true });
    // Same owner/IP, separate browser contexts (not cross-owner access).
    // A second control with equal text and a real PNG must remain a distinct entry.
    const observerContext = await page.context().browser()!.newContext();
    observer = await observerContext.newPage();
    await instrument(observer, "observer");
    await observer.goto("http://127.0.0.1:5269/");
    const observerSubscribing = observer.waitForRequest(request => new URL(request.url()).pathname === "/v1/sessions/steering-test/events");
    await observer.getByTestId("session-steering-test").click();
    await observerSubscribing;
    await expect(observer.locator(".message-user")).toHaveCount(2);
    // Cold join exports the latest cursor but does not restore active-task phase.
    // Vite buffers SSE headers until an event: await the request here, not fetch's response.
    // Do not pretend this window can steer through Composer yet.
    await expect(observer.getByTestId("abort-button")).toHaveCount(0);
    const imageAck = await observer.evaluate(async ({ body, png }) => {
      const response = await fetch("/v1/sessions/steering-test/steer", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你现在在干嘛？", requestId: body.requestId, controlId: "image-control", acknowledgementId: "other-browser-token",
          images: [{ mediaType: "image/png", base64: png }] }) });
      return response.status;
    }, { body, png });
    expect(imageAck).toBe(202);
    await expect(page.locator(".message-user")).toHaveCount(2);
    // Queue B before C. Remove the old attachment before sending C (file steering is unsupported),
    // then create a new draft/attachment to prove another window's B ack cannot clear it.
    await page.getByRole("button", { name: "移除附件 new-draft.png", exact: true }).click();
    await input.fill("主窗口未消费的插话 C");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(page.getByRole("region", { name: "追加队列", exact: true }).getByTestId("control-queue-item")).toHaveCount(1);
    await page.getByRole("button", { name: "引导：主窗口未消费的插话 C", exact: true }).click();
    await expect(page.getByRole("region", { name: "引导队列", exact: true }).getByTestId("control-queue-item")).toHaveCount(2);
    await expect(page.getByTestId("control-queue-item").filter({ hasText: "主窗口未消费的插话 C" })).toHaveCount(1);
    await expect(page.getByTestId("composer-pending-controls")).toHaveCount(0);
    await input.fill("新草稿不能丢");
    await page.getByTestId("composer-file-input").setInputFiles({ name: "new-draft.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect(page.getByTestId("composer-attachment")).toHaveAttribute("data-state", "ready");
    f.release(); await expect.poll(f.waits).toBe(3);
    await expect.poll(() => network.filter(row => row.window === "observer" && row.kind === "sse-ready")).toEqual([
      expect.objectContaining({ status: 200, contentType: expect.stringContaining("text/event-stream") }),
    ]);
    await expect.poll(async () => (await events("observer")).filter(e => e.type === "steering_consumed" && e.controlId === "image-control")).toEqual([
      expect.objectContaining({ acknowledgementId: "other-browser-token", requestId: body.requestId,
        message: expect.objectContaining({ sourceId: expect.any(String), text: "你现在在干嘛？" }) }),
    ]);
    await expect(page.locator(".message-user")).toHaveCount(3);
    await expect(page.locator(".message-user").last().locator("img")).toHaveCount(1);
    await expect(observer.locator(".message-user")).toHaveCount(3);
    await expect(observer.locator(".message-user").last().locator("img")).toHaveCount(1);
    // Seeing the other context's consumption must not clear C's authoritative queue entry or draft.
    await expect(page.getByTestId("control-queue-item")).toHaveCount(1);
    await expect(page.getByTestId("control-queue-item")).toContainText("主窗口未消费的插话 C");
    const queuedC = requests.find(r => r.body.text === "主窗口未消费的插话 C")!.body;
    expect(await readQueue()).toMatchObject({ requestId: body.requestId, items: [expect.objectContaining({ id: queuedC.controlId, acknowledgementId: queuedC.acknowledgementId })] });
    await expect(input).toHaveValue("新草稿不能丢");
    await expect(page.getByTestId("composer-attachment")).toContainText("new-draft.png");
    // B's real SDK turn_start (not a synthetic status) makes the observer streaming.
    await expect.poll(async () => (await events("observer")).some(e => e.type === "status" && e.phase === "turn_start")).toBe(true);
    await expect(observer.getByTestId("abort-button")).toBeVisible();
    await expect(observer.locator('.composer-runtime-controls')).toHaveCount(0);
    await observer.screenshot({ path: join(artifact, "same-owner-browser-visible.png"), fullPage: true });
    // Detach and return: cached timeline plus retained SSE replay must not repeat users.
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    await page.getByTestId("session-steering-test").click();
    await expect(page.locator(".message-user")).toHaveCount(3);
    await expect(page.getByTestId("control-queue-item")).toHaveCount(1);
    await page.reload();
    // Recent selection restores history automatically; cold-join active-task phase is unchanged.
    await expect(page.getByTestId("session-steering-test")).toBeVisible();
    await expect(page.locator(".message-user")).toHaveCount(3);
    await expect(page.locator(".message-user").last().locator("img")).toHaveCount(1);
    expect(f.session.isStreaming).toBe(true);
    await expect(page.getByTestId("control-queue-item")).toHaveCount(1);
    expect(await readQueue()).toMatchObject({ items: [expect.objectContaining({ id: queuedC.controlId })] });
    await expect(page.locator(".message-user").filter({ hasText: "你现在在干嘛？" })).toHaveCount(3);
    sdkStreamingAtScreenshot = f.session.isStreaming;
    await page.screenshot({ path: join(artifact, "final-success.png"), fullPage: true });
    // No stop UI: abort through direct HTTP -> runtime -> SDK, while C remains unconsumed.
    const abortResponse = observer.waitForResponse(r => r.url().endsWith("/abort") && r.request().method() === "POST");
    await observer.evaluate(async () => { await fetch('/v1/sessions/steering-test/abort', {method:'POST'}); });
    expect((await abortResponse).status()).toBe(204);
    await expect.poll(async () => (await events("observer")).some(e => e.type === "aborted")).toBe(true);
    await expect.poll(() => f.session.isStreaming).toBe(false);
    await expect(observer.getByTestId("abort-button")).toHaveCount(0);
    await expect(observer.getByTestId("control-queue-item")).toHaveCount(0);
    await expect(page.getByTestId("control-queue-item")).toHaveCount(0);
    expect(await readQueue()).toMatchObject({ items: [] });
    await expect(observer.locator(".message-user")).toHaveCount(3);
    await expect(page.locator(".message-user")).toHaveCount(3);
    expect(requests.filter(r => r.url.endsWith("/steer"))).toHaveLength(1); // Only the observer's explicit API steering.
    const controls = requests.filter(r => r.url.endsWith("/follow-ups"));
    expect(controls).toHaveLength(3);
    const c = controls.find(r => r.body.text === "主窗口未消费的插话 C")!;
    expect(c.window).toBe("main");
    for (const windowName of ["main", "observer"]) {
      const acknowledgements = (await events(windowName)).filter(e => e.type === "steering_consumed");
      expect(acknowledgements.filter(e => e.controlId === "image-control")).toHaveLength(1);
      expect(acknowledgements.some(e => e.controlId === c.body.controlId || e.controlId === follow.controlId)).toBe(false);
    }
    expect(f.session.sessionManager.getEntries().filter((e: any) => e.type === "message" && e.message.role === "user")).toHaveLength(3);
  } catch (error) {
    failures.push({ error: String(error), stack: error instanceof Error ? error.stack : undefined });
    await page.screenshot({ path: join(artifact, "failure-main.png"), fullPage: true }).catch(() => {});
    await observer?.screenshot({ path: join(artifact, "failure-observer.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    // Persist this run's cross-page evidence before any teardown/cleanup abort.
    writeFileSync(join(artifact, "http-sse-evidence.json"), JSON.stringify({ requests, network, failures,
      events: { main: await events(), observer: await events("observer") }, sdkStreamingAtScreenshot,
      sdkStreamingAfterAbort: f.session.isStreaming, cursors, sdkWaits: f.waits(), branch: f.session.sessionManager.getEntries() }, null, 2));
    await observer?.context().close();
    await f.adapter.abort(); await app.close(); await db.close(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
