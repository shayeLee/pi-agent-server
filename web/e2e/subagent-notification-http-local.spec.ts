import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../src/server/app.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { projectExportSnapshot } from "../../src/agent/session-export.js";
import { notificationFromEntry, type NotificationEvent } from "../../src/agent/subagent-notification.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../../tests/helpers/ip-access.js";

test("isolated real App: idle SSE, duplicate delivery/history dedup, same-text user, safe notification and 1280/390 themes", async ({ page }) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-notification-http-"));
  const storage = await makeInitializedMemoryDb({ dataDir: root });
  const text = "1 background subagent result(s) are waiting to be collected. Call subagent_wait to read the full result.\n\n### [worker] run run-a — stopped\n\n已停止，保留已有结果。\n\n- 状态：stopped\n- 不代表 completed\n\n```ts\nconst result = 'partial';\n```\n\n![禁止网络图片](https://notification.invalid/image.png)";
  const timestamp = "2026-01-01T00:00:00Z";
  const marker = { type: "custom", customType: "agent-team:notification", id: "marker", parentId: "first", timestamp, data: { version: 1, notificationId: "8b58f83a-b77d-4e31-99de-47753962fb0f", runIds: ["run-a"], text } };
  const branch: any[] = [{ type: "message", id: "first", parentId: null, timestamp, message: { role: "user", content: "真正用户任务", timestamp: 1 } }];
  const file = path.join(root, "sessions", "notice", "fixture.jsonl"); mkdirSync(path.dirname(file), { recursive: true });
  const persist = () => writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "notice", cwd: root, timestamp }), ...branch.map(row => JSON.stringify(row)), ""].join("\n")); persist();
  await storage.sessions.create({ id: "notice", title: "", ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }), projectId: DEFAULT_PROJECT_ID, createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: file, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  class Adapter extends MockAgentAdapter {
    notify?: (event: NotificationEvent) => void;
    subscribeNotifications(listener: (event: NotificationEvent) => void) { this.notify = listener; return () => { this.notify = undefined; }; }
    override async exportSession() { return projectExportSnapshot([], branch); }
  }
  const adapter = new Adapter([]);
  const registry = new ConversationStorageRegistry(); registry.register(new PiJsonlConversationStorage(root));
  const app = buildApp({ sessions: storage.sessions, projects: storage.projects, defaultProjectCwd: root, ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "127.0.0.1", role: "user" }]) }), conversationStorage: registry, createAdapter: async () => adapter });
  try {
    await app.listen({ host: "127.0.0.1", port: 5248 });
    // Read detached synthetic JSONL first; no real session store or model is involved.
    const detached = await fetch("http://127.0.0.1:5248/v1/sessions/notice/export"); expect((await detached.json()).timeline).toHaveLength(1);
    const initialized = await fetch("http://127.0.0.1:5248/v1/sessions/notice/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "initialize", prompt: "fake SDK initialization" }) });
    expect(initialized.status).toBe(202);
    await expect.poll(() => typeof adapter.notify).toBe("function");
    let images = 0; await page.route("https://notification.invalid/**", route => { images++; return route.abort(); });
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
    const exported = page.waitForResponse(response => response.url().endsWith("/sessions/notice/export") && response.status() === 200);
    const subscribing = page.waitForRequest(request => request.url().includes("/sessions/notice/events"));
    const streaming = page.waitForResponse(response => response.url().includes("/sessions/notice/events") && response.status() === 200);
    await page.getByTestId("session-notice").click();
    const subscription = await subscribing;
    const snapshot = await (await exported).json();
    expect(subscription.headers()["last-event-id"]).toBe(String(snapshot.lastEventId));
    await expect(page.getByTestId("stat-turns")).toHaveCount(0); // Unknown execution counts are omitted, not inferred from users.
    await expect(page.locator(".message-user")).toHaveCount(1);
    // Idle SSE headers can remain buffered by Vite until the first body chunk.
    // Wait for the request, inject the real entry-derived event, then await HTTP 200.
    const notification = notificationFromEntry(marker);
    expect(notification).not.toBeNull();
    expect(typeof adapter.notify).toBe("function");
    branch.push(marker); persist(); adapter.notify!(notification!); adapter.notify!(notification!);
    await streaming;
    await expect(page.getByTestId("subagent-notification")).toHaveCount(1);
    await expect(page.getByTestId("subagent-notification").getByRole("heading", { name: /worker/ })).toBeVisible();
    await expect(page.getByTestId("subagent-notification")).toContainText("stopped");
    await page.getByTestId("subagent-notification").getByRole("button", { name: "Markdown 展示" }).click();
    await expect(page.getByTestId("subagent-notification").locator("pre")).toContainText("### [worker]");
    await page.getByTestId("subagent-notification").getByRole("button", { name: "Markdown 展示" }).click();
    await expect(page.getByTestId("subagent-notification").getByRole("heading", { name: /worker/ })).toBeVisible();
    await expect(page.getByTestId("stat-turns")).toHaveCount(0);
    await expect(page.locator(".message-user")).toHaveCount(1);
    await expect(page.getByTestId("chat-session-title")).toHaveAttribute("title", "真正用户任务");
    expect(await page.getByTestId("subagent-notification").locator("img").count()).toBe(0); expect(images).toBe(0);
    // Companion custom message and same-text user are not guessed from prose.
    branch.push({ type: "custom_message", id: "companion", parentId: "marker", timestamp, customType: "agent-team:results-ready", content: text, display: false, details: { version: 1, notificationId: marker.data.notificationId } }, { type: "message", id: "same-user", parentId: "companion", timestamp, message: { role: "user", content: text, timestamp: 2 } }); persist();
    // Reload validates export/history deduplication, not SSE replay.
    await page.reload(); await page.getByTestId("session-notice").click();
    await expect(page.getByTestId("subagent-notification")).toHaveCount(1);
    expect(await page.locator(".message-user").count()).toBe(2);
    await expect(page.locator(".message-user").last()).toContainText("1 background subagent result(s)");
    await expect(page.getByTestId("stat-turns")).toHaveCount(0);
    await page.getByRole("button", { name: "查看统计详情" }).click();
    await expect(page.getByRole("dialog")).toContainText("执行计数未知");
    await page.getByRole("button", { name: "关闭对话框" }).click();
    await expect(page.getByTestId("chat-session-title")).toHaveAttribute("title", "真正用户任务");
    mkdirSync("/tmp/notification-display-mode/read", { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.querySelector(".app-shell")!.setAttribute("data-theme", value), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (width === 390) {
          // Let the responsive drawer transition finish before visual acceptance.
          await expect.poll(async () => {
            const box = await page.getByTestId("sidebar").boundingBox();
            return box ? box.x + box.width : 0;
          }).toBeLessThanOrEqual(0);
        }
        await page.getByTestId("subagent-notification").scrollIntoViewIfNeeded();
        await page.screenshot({ path: width === 390 ? `/tmp/notification-display-mode/read/${theme}-390.png` : `/tmp/subagent-notification/${theme}-${width}.png`, fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  } finally { await app.close(); await storage.close(); rmSync(root, { recursive: true, force: true }); }
});
