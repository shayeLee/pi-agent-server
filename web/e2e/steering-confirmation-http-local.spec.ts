import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.js";
import { steeringSdkFixture } from "../../tests/agent/steering-sdk-fixture.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makeTestIpAccess } from "../../tests/helpers/ip-access.js";

test("202 is admission only; real SDK user consumption removes exactly owned pending once before primary terminal", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "pi-steering-browser-"));
  const artifact = "/tmp/steering-confirmation"; mkdirSync(artifact, { recursive: true });
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
  page.on("request", r => { if (r.method() === "POST") requests.push({ url: r.url(), body: r.postDataJSON() }); });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.addInitScript(() => {
    const evidence: any[] = []; (window as any).__steeringEvidence = evidence;
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await fetch(...args);
      const url = String(args[0]);
      if (url.endsWith("/steer")) evidence.push({ url, status: res.status });
      if (url.includes("/events") && res.body) {
        const row = { url, status: res.status, frames: [] as string[] }; evidence.push(row);
        const reader = res.clone().body!.getReader();
        void (async () => { let pending = ""; const decoder = new TextDecoder();
          try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true }); let end: number;
            while ((end = pending.indexOf("\n\n")) >= 0) { row.frames.push(pending.slice(0, end)); pending = pending.slice(end + 2); }
          } } catch { /* isolation teardown */ }
        })();
      }
      return res;
    };
  });
  const evidence = () => page.evaluate(() => (window as any).__steeringEvidence as any[]);
  const events = async () => (await evidence()).flatMap(row => (row.frames ?? []).flatMap((frame: string) => {
    const data = frame.split("\n").find(line => line.startsWith("data: ")); return data ? [JSON.parse(data.slice(6))] : [];
  }));
  try {
    await app.listen({ host: "127.0.0.1", port: 5268 });
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
    await page.getByTestId("session-steering-test").click();
    const input = page.getByTestId("composer-input"); await input.fill("你现在在干嘛？"); await input.press("Enter");
    await expect.poll(f.waits).toBe(1);
    await input.fill("你现在在干嘛？");
    await input.press("Enter");
    await expect.poll(async () => (await evidence()).filter(e => e.url.endsWith("/steer")).map(e => e.status)).toEqual([202]);
    await expect(page.getByTestId("composer-pending-controls")).toContainText("HTTP 已接收，等待消费确认");
    await input.press("Enter"); // Same immutable draft cannot be submitted again while its outcome is unresolved.
    expect(requests.filter(r => r.url.endsWith("/steer"))).toHaveLength(1);
    expect((await events()).filter(e => e.type === "steering_consumed")).toHaveLength(0);
    await page.screenshot({ path: join(artifact, "submitted-waiting-consumption.png"), fullPage: true });
    await input.fill("新草稿不能丢");
    f.release();
    await expect.poll(f.waits).toBe(2);
    await expect(page.getByTestId("composer-pending-controls")).toHaveCount(0);
    await expect(input).toHaveValue("新草稿不能丢");
    await expect(page.locator(".message-assistant").last()).toContainText("正在写代码，主任务继续。");
    const captured = await events();
    const ack = captured.filter(e => e.type === "steering_consumed"); expect(ack).toHaveLength(1);
    const body = requests.find(r => r.url.endsWith("/steer"))!.body;
    expect(ack[0]).toEqual({ type: "steering_consumed", controlId: body.controlId, acknowledgementId: body.acknowledgementId, requestId: body.requestId });
    expect(captured.some(e => ["completed", "aborted", "error"].includes(e.type))).toBe(false);
    expect(f.session.isStreaming).toBe(true);
    await page.screenshot({ path: join(artifact, "final.png"), fullPage: true });
    writeFileSync(join(artifact, "http-sse-evidence.json"), JSON.stringify({ requests, network: await evidence(), events: captured,
      sdkStreaming: f.session.isStreaming, sdkWaits: f.waits(), branch: f.session.sessionManager.getEntries() }, null, 2));
  } finally {
    await f.adapter.abort(); await app.close(); await db.close(); globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
