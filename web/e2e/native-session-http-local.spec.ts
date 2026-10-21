import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { nativeProjectDirectory } from "../../src/agent/native-session-source.js";
import { makeTestIpAccess } from "../../tests/helpers/ip-access.js";
import { providerFixture } from "./native-session-provider.fixture.js";
import { isolateProjectDiscovery } from "./project-discovery-isolation.fixture.js";

const artifacts = "/tmp/native-session-final-ui";
// Actual App + startServer + SQLite + SDK + HTTP/SSE. Only provider inference is offline/fake.
test("unified native directory: real App, actors, append, private, tombstones, exclusion", async ({ page }) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-final-")));
  const cwd = path.join(root, "project"); mkdirSync(cwd);
  const nativeRoot = path.join(root, "native");
  const dir = path.join(nativeRoot, nativeProjectDirectory(cwd)); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "original.jsonl");
  const timestamp = "2026-01-01T00:00:00Z";
  const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const rows = [
    { type: "session", version: 3, id: "native-original", cwd, timestamp },
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "原生历史任务", timestamp: 1 } },
    { type: "message", id: "assistant", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "原生思考记录" }, { type: "text", text: "原生历史回答" }, { type: "toolCall", id: "tool", name: "read", arguments: { path: "fixture.txt" } }, { type: "toolCall", id: "old-tool", name: "read", arguments: { path: "legacy.txt" } }], api: "native-fixture-api", provider: "native-fixture", model: "offline", usage, stopReason: "toolUse", timestamp: 2 } },
    { type: "message", id: "result", parentId: "assistant", timestamp, message: { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "原生工具结果" }], isError: false, timestamp: 3, durationMs: 2345.6789 } },
    { type: "message", id: "old-result", parentId: "result", timestamp, message: { role: "toolResult", toolCallId: "old-tool", toolName: "read", content: [{ type: "text", text: "无计时历史结果" }], isError: false, timestamp: 4 } },
    { type: "custom", customType: "agent-team:notification", id: "notice", parentId: "old-result", timestamp, data: { version: 1, notificationId: "8b58f83a-b77d-4e31-99de-47753962fb0f", runIds: ["run-native"], text: "### 原生通知\n\n离线任务已完成" } },
    { type: "model_change", id: "model", parentId: "notice", timestamp, provider: "native-fixture", modelId: "offline" },
    { type: "session_info", id: "name", parentId: "model", timestamp, name: "原生命名会话" },
  ];
  const before = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(file, before);
  const fallback = path.join(dir, "first-prompt.jsonl");
  writeFileSync(fallback, rows.slice(0, 2).map(row => JSON.stringify(row).replace("native-original", "native-first")).join("\n") + "\n");
  const legacy = path.join(dir, "legacy.jsonl"); const legacyBytes = before.replace('"version":3', '"version":2'); writeFileSync(legacy, legacyBytes);
  const extension = path.join(root, "offline-provider.ts"); writeFileSync(extension, providerFixture);
  const dbPath = path.join(root, "test.sqlite");
  const db = new DatabaseSync(dbPath); try { await runSqliteMigrations(db); } finally { db.close(); }
  const config: StartConfig = { port: 5258, host: "127.0.0.1", cwd, dbPath,
    dataDir: path.join(root, "managed"), agentDir: path.join(root, "agent"), authPath: path.join(root, "auth.json"),
    nativeSessionSourceDir: nativeRoot, ipAccess: makeTestIpAccess({ cidrs: ["127.0.0.1/32", "::1/128"] }),
    extensionPaths: [extension], defaultModel: { provider: "native-fixture", id: "offline" }, tools: [], systemPrompt: "Offline acceptance only." };
  mkdirSync(config.agentDir!, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, "agent-b"), { recursive: true, mode: 0o700 });
  writeFileSync(config.authPath!, "{}", { mode: 0o600 });
  for (const dir of [config.agentDir!, path.join(root, "agent-b")]) writeFileSync(path.join(dir, "models.json"), "{}", { mode: 0o600 });
  const isolation = isolateProjectDiscovery(root);
  await page.route("**/*", route => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let actorB: typeof app;
  const api = async (url: string, init?: RequestInit, base = "http://127.0.0.1:5258") => fetch(base + "/v1" + url, init);
  const list = async (base?: string) => { const response = await api("/sessions", undefined, base); expect(response.status).toBe(200); return response.json(); };
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const sseResponses: { status: number; contentType: string }[] = [];
  page.on("response", response => {
    if (/\/events(?:\?|$)/.test(response.url())) sseResponses.push({ status: response.status(), contentType: response.headers()["content-type"] ?? "" });
  });
  try {
    app = await startServer(config);
    // Two real loopback TCP actors, two composition roots, one isolated persistent database/source.
    actorB = await startServer({ ...config, host: "::1", port: 0, agentDir: path.join(root, "agent-b") });
    const addressB = actorB.server.address(); if (!addressB || typeof addressB === "string") throw new Error("missing B socket");
    const baseB = `http://[::1]:${addressB.port}`;
    const sessions = await list(); expect(sessions).toHaveLength(2);
    const named = sessions.find((row: any) => row.title === "原生命名会话"); expect(named).toBeTruthy(); const id = named.id;
    expect(named).toMatchObject({ origin: "native", visibility: "shared" }); expect(id).not.toBe("native-original");
    const first = sessions.find((row: any) => row.id !== id); expect(first).toMatchObject({ title: "", firstPrompt: "原生历史任务" });
    expect((await list(baseB)).map((row: any) => row.id).sort()).toEqual(sessions.map((row: any) => row.id).sort());
    const snapshotResponse = await api(`/sessions/${id}/export`); expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.timeline.map((row: { type: string }) => row.type)).toEqual(expect.arrayContaining(["thinking", "tool_call", "tool_result", "notification"]));
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
    await expect(page.getByTestId(`session-${id}`)).toContainText("原生命名会话");
    await expect(page.getByTestId(`session-${first.id}`)).toContainText("原生历史任务");
    await page.getByTestId(`session-${id}`).click();
    await expect(page.locator(".message-assistant")).toContainText("原生历史回答");
    await page.getByRole("button", { name: /思考过程/ }).click();
    await expect(page.locator(".thinking-body")).toContainText("原生思考记录");
    await expect(page.getByTestId("subagent-notification")).toContainText("原生通知");
    // Finished tool steps sit folded inside work blocks.
    for (const block of await page.locator('.work-header[aria-expanded="false"]').all()) await block.click();
    await expect(page.getByText("fixture.txt", { exact: false }).first()).toBeVisible();
    const historicalTool = page.locator('[data-tool-call-id="tool"]');
    await expect(historicalTool.locator(".tool-duration")).toHaveText("2.3s");
    await expect(page.locator('[data-tool-call-id="old-tool"] .tool-duration')).toHaveCount(0);
    if (await historicalTool.locator('.tool-call-header').getAttribute('aria-expanded') === 'false') await historicalTool.locator('.tool-call-header').click();
    await expect(historicalTool.locator('.tool-duration')).toHaveAttribute('title', '工具调用耗时：2345.6789 ms');
    await expect(historicalTool.locator('.tool-call-body')).toBeVisible();
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/duration-history-expanded.png`, fullPage: true });
    const send = page.waitForResponse(response => response.url().endsWith(`/sessions/${id}/messages`) && response.request().method() === "POST");
    await page.getByTestId("composer-input").fill("原生继续发送"); await page.getByTestId("send-button").click(); expect((await send).status()).toBe(202);
    await expect(page.locator(".message-assistant").last()).toContainText("离线模型继续完成");
    await expect.poll(() => readFileSync(file, "utf8")).toContain("原生继续发送");
    expect(readFileSync(file, "utf8").startsWith(before)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).id).toBe("native-original");
    expect(readdirSync(dir).sort()).toEqual(["first-prompt.jsonl", "legacy.jsonl", "original.jsonl"]);
    expect(readdirSync(root, { recursive: true }).filter(name => String(name).endsWith(".jsonl")).map(String).sort()).toEqual(
      [fallback, legacy, file].map(name => path.relative(root, name)).sort());
    mkdirSync(artifacts, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
      await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        // Resizing desktop → mobile also animates the closed drawer; do not capture mid-transition.
        if (width === 390) await expect.poll(() => page.getByTestId("sidebar").evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
        else await expect.poll(() => page.getByTestId("sidebar").evaluate(el => Math.round(el.getBoundingClientRect().x))).toBe(0);
        await page.screenshot({ path: `${artifacts}/${theme}-${width}-history.png`, fullPage: true });
        if (width === 390) {
          await page.getByRole("button", { name: "打开工作区导航" }).click();
          await expect.poll(() => page.getByTestId("sidebar").evaluate(el => Math.round(el.getBoundingClientRect().x))).toBe(0);
        }
        await page.screenshot({ path: `${artifacts}/${theme}-${width}-shared.png`, fullPage: true });
        if (width === 390) {
          // The backdrop center is under the drawer: use its actual visible close control, never force.
          await page.getByTestId("toggle-sidebar").click();
          await expect(page.getByTestId("app")).not.toHaveClass(/mobile-sidebar-open/);
          await expect(page.getByRole("button", { name: "关闭工作区导航" })).toBeHidden();
          await expect.poll(() => page.getByTestId("sidebar").evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
          await page.getByTestId("composer-input").click(); await page.getByTestId("composer-input").fill("关闭导航后的真实输入");
          await expect(page.getByTestId("composer-input")).toBeFocused();
          await page.screenshot({ path: `${artifacts}/${theme}-390-overlay-closed.png`, fullPage: true });
          await page.getByTestId("composer-input").fill("");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const created = page.waitForResponse(response => response.url().endsWith("/v1/sessions") && response.request().method() === "POST");
    await page.getByTestId("new-session").click();
    await expect(page.getByTestId("composer-input")).toBeEmpty();
    await page.screenshot({ path: `${artifacts}/dark-1280-new-draft.png`, fullPage: true });
    await page.getByTestId("composer-input").fill("Web私有任务"); await page.getByTestId("send-button").click();
    const createdResponse = await created; expect(createdResponse.status()).toBe(201);
    const privateSession = await createdResponse.json();
    await expect(page.locator(".message-assistant").last()).toContainText("离线模型继续完成");
    await page.screenshot({ path: `${artifacts}/dark-1280-private.png`, fullPage: true });
    const privateFiles = readdirSync(dir).filter(name => !["first-prompt.jsonl", "legacy.jsonl", "original.jsonl"].includes(name)); expect(privateFiles).toHaveLength(1);
    const privateFile = path.join(dir, privateFiles[0]!); const privateBytes = readFileSync(privateFile, "utf8"); expect(privateBytes).toContain("Web私有任务");
    expect(JSON.parse(privateBytes.split("\n")[0]!).cwd).toBe(cwd);
    const privateListed = (await list()).find((row: any) => row.id === privateSession.id); expect(privateListed.visibility ?? "private").toBe("private"); // Contract: omitted means private/managed.
    expect((await list(baseB)).some((row: any) => row.id === privateSession.id)).toBe(false);
    expect((await api(`/sessions/${privateSession.id}/export`, undefined, baseB)).status).toBe(404);
    expect((await api(`/sessions/${privateSession.id}`, { method: "DELETE" }, baseB)).status).toBe(404);
    const sharedBytes = readFileSync(file, "utf8");
    for (const deletedId of [id, privateSession.id]) expect((await api(`/sessions/${deletedId}`, { method: "DELETE" })).status).toBe(204);
    expect(readFileSync(file, "utf8")).toBe(sharedBytes); expect(readFileSync(privateFile, "utf8")).toBe(privateBytes);
    for (const base of [undefined, baseB]) expect((await list(base)).map((row: any) => row.id)).toEqual([first.id]);
    await actorB.close(); actorB = undefined; await app.close(); app = undefined;
    // Reopen the same isolated DB with an explicit exclusion: already-indexed source is hidden (404).
    app = await startServer({ ...config, sessionShareExcludeCwds: [cwd] });
    expect(await list()).toEqual([]);
    for (const suffix of ["", "/export"]) expect((await api(`/sessions/${first.id}${suffix}`)).status).toBe(404);
    expect((await api(`/sessions/${first.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "excluded-send", prompt: "must not run" }) })).status).toBe(404);
    await app.close(); app = await startServer(config);
    expect((await list()).map((row: any) => row.id)).toEqual([first.id]);
    expect(readFileSync(legacy, "utf8")).toBe(legacyBytes); expect(readFileSync(privateFile, "utf8")).toBe(privateBytes); expect(readFileSync(file, "utf8")).toBe(sharedBytes);
    expect(errors).toEqual([]);
    expect(sseResponses).toContainEqual({ status: 200, contentType: "text/event-stream" });
    writeFileSync(`${artifacts}/evidence.json`, JSON.stringify({ root, cwd, nativeRoot, dbPath, id, privateId: privateSession.id, actorA: "127.0.0.1", actorB: "::1", transport: "real TCP, two startServer instances sharing isolated SQLite/source", fake: "offline provider inference only", sseResponses, screenshots: readdirSync(artifacts).filter(name => /^(light|dark)-.*\.png$/.test(name)), checks: "native name/first prompt/history/append/private/delete/restart/exclusion/v2/mobile close passed" }, null, 2));
  } catch (error) {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(`${artifacts}/failure-original.jsonl`, readFileSync(file));
    if (!page.isClosed()) {
      writeFileSync(`${artifacts}/failure-ui.txt`, await page.locator("body").innerText({ timeout: 2000 }));
      await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true, timeout: 2000 });
    }
    throw error;
  } finally { await actorB?.close(); await app?.close(); isolation.restore(); rmSync(root, { recursive: true, force: true }); }
});
