import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.js";
import { steeringSdkFixture } from "../../tests/agent/steering-sdk-fixture.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../../tests/helpers/ip-access.js";

test("real SDK offline: nondefault selection survives two Chrome reloads without writes", async ({ page, browser }) => {
  const output = "/tmp/recent-session-restore";
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "pi-recent-offline-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("offline fixture denies non-loopback");
    return originalFetch(input, init);
  };
  const db = await makeInitializedMemoryDb({ dataDir: root });
  const fixtures = await Promise.all(["one", "two"].map(async name => {
    const dir = join(root, name); mkdirSync(dir);
    return steeringSdkFixture(dir, session => session.sessionManager.appendMessage({ role: "user", content: `Synthetic ${name} history`, timestamp: 1 }));
  }));
  const ownerKey = identityKey({ kind: "ip", ip: "127.0.0.1" });
  const projectId = "00000000-0000-4000-8000-000000000002";
  await db.projects.create({ id: projectId, name: "Synthetic second project", cwd: root, ownerKey, createdAt: 1 });
  for (const [i, id] of ["recent-one", "recent-two"].entries()) await db.sessions.create({ id, title: `Synthetic session ${i + 1}`, ownerKey,
    projectId: i ? projectId : DEFAULT_PROJECT_ID, createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  // Read the synthetic real SDK messages without creating any service runtime.
  const storage = new ConversationStorageRegistry();
  storage.register({ agentKind: "pi", conversationFormat: "pi-jsonl-v3", planCleanup: () => null,
    readExport: async (_conversation, context) => fixtures[context.sessionId === "recent-two" ? 1 : 0].adapter.exportSession() });
  let adapterCreations = 0;
  const app = buildApp({ sessions: db.sessions, projects: db.projects, defaultProjectCwd: root,
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "127.0.0.1", role: "viewer" }]) }), conversationStorage: storage,
    createAdapter: async () => { adapterCreations++; throw new Error("restore must not create SDK runtime"); } });
  const reads: string[] = []; const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v1/")) (request.method() === "GET" ? reads : writes).push(`${request.method()} ${path}${new URL(request.url()).search}`);
  });
  await page.route("**/*", route => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  try {
    await app.listen({ host: "127.0.0.1", port: 5278 });
    const exported = await originalFetch("http://127.0.0.1:5278/v1/sessions/recent-two/export");
    expect(exported.status).toBe(200);
    expect((await exported.json()).messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Synthetic two history" })]));
    await page.goto("/");
    await expect(page.getByTestId("session-recent-one")).toBeVisible();
    // Initial visit is default/blank. Select the nondefault project through the UI.
    await page.getByTestId("project-select").click();
    await page.getByText("Synthetic second project", { exact: true }).click();
    await page.getByTestId("session-recent-two").click();
    await expect(page.getByTestId("message-list")).toContainText("Synthetic two history");
    const reloads: string[][] = [];
    for (let i = 1; i <= 2; i++) {
      reads.length = 0;
      await page.reload();
      await expect(page.getByTestId("message-list")).toContainText("Synthetic two history");
      await expect(page.getByTestId("session-recent-two")).toBeVisible();
      expect(reads.filter(path => path.endsWith("/export"))).toEqual(["GET /v1/sessions/recent-two/export"]);
      expect(reads.filter(path => path.startsWith("GET /v1/sessions?"))).toEqual([`GET /v1/sessions?projectId=${projectId}`]);
      expect(writes).toEqual([]);
      reloads.push([...reads]);
      await page.screenshot({ path: join(output, `reload-${i}.png`), fullPage: true });
    }
    expect(adapterCreations).toBe(0);
    expect(fixtures.map(f => f.calls())).toEqual([0, 0]);
    await page.screenshot({ path: join(output, "final.png"), fullPage: true });
    writeFileSync(join(output, "actual-read.json"), JSON.stringify({ browser: browser.version(), reloads, writes, adapterCreations, sdkProviderCalls: fixtures.map(f => f.calls()), stored: await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))) }, null, 2));
  } finally {
    await page.goto("about:blank"); await app.close();
    fixtures.forEach(f => f.session.dispose()); await db.close(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true });
  }
});
