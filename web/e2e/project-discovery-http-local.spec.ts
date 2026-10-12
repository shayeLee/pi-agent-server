import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { nativeProjectDirectory } from "../../src/agent/native-session-source.js";
import { makeTestIpAccess } from "../../tests/helpers/ip-access.js";
import { providerFixture } from "./native-session-provider.fixture.js";
import { isolateProjectDiscovery } from "./project-discovery-isolation.fixture.js";

// Real App/HTTP/SDK; all working directories, source and SQLite are temporary fixtures.
test("two unregistered Pi workspaces switch histories; zero/excluded hidden; explicit draft first send", async ({ page }) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "project-discovery-")));
  const source = path.join(root, "source"); mkdirSync(source);
  const cwd = path.join(root, "default-empty"); mkdirSync(cwd);
  const make = (name: string) => {
    const dir = path.join(root, name); mkdirSync(dir);
    const sessions = path.join(source, nativeProjectDirectory(dir)); mkdirSync(sessions);
    writeFileSync(path.join(sessions, "session.jsonl"), [
      { type: "session", version: 3, id: name, cwd: dir, timestamp: "2026-01-01T00:00:00Z" },
      { type: "model_change", id: "model", parentId: null, timestamp: "2026-01-01T00:00:00Z", provider: "native-fixture", modelId: "offline" },
      { type: "message", id: "prompt", parentId: "model", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `${name} history`, timestamp: 1 } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    return dir;
  };
  const cwdA = make("workspace-a"); const cwdB = make("workspace-b"); const excluded = make("excluded");
  mkdirSync(path.join(source, "--empty--"));
  const draft = path.join(root, "draft"); mkdirSync(draft);
  const extension = path.join(root, "offline.ts"); writeFileSync(extension, providerFixture);
  const dbPath = path.join(root, "fixture.sqlite");
  const db = new DatabaseSync(dbPath); try { await runSqliteMigrations(db); } finally { db.close(); }
  const config = { host: "127.0.0.1", port: 5258, cwd, dbPath,
    dataDir: path.join(root, "data"), agentDir: path.join(root, "agent"), authPath: path.join(root, "auth.json"),
    nativeSessionSourceDir: source, sessionShareExcludeCwds: [excluded],
    uploadStorageRoot: path.join(root, "uploads"), uploadAgentRoot: path.join(root, "uploads"),
    uploadOwnerQuotaBytes: 1024 * 1024, uploadGlobalQuotaBytes: 2 * 1024 * 1024,
    ipAccess: makeTestIpAccess({ cidrs: ["127.0.0.0/8"] }), extensionPaths: [extension],
    defaultModel: { provider: "native-fixture", id: "offline" }, tools: [], systemPrompt: "Offline fixture only." };
  mkdirSync(config.agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(config.authPath, "{}", { mode: 0o600 });
  writeFileSync(path.join(config.agentDir, "models.json"), "{}", { mode: 0o600 });
  const isolation = isolateProjectDiscovery(root);
  const posts: number[] = [];
  page.on("response", response => { if (response.request().method() === "POST" && /\/messages$/.test(new URL(response.url()).pathname)) posts.push(response.status()); });
  // Chromium is also restricted to the local fixture UI/API (no remote assets).
  await page.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    return ["127.0.0.1", "localhost"].includes(host) ? route.continue() : route.abort();
  });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
  app = await startServer({ ...config, cwd: cwdA });
    const apiProjects = await (await fetch("http://127.0.0.1:5258/v1/projects")).json();
    expect(apiProjects.map((p: any) => p.name).sort()).toEqual(["workspace-b", "默认项目"]);
    expect(apiProjects.find((p: any) => p.isDefault).cwd).toBe(cwdA);
    const originalA = await (await fetch(`http://127.0.0.1:5258/v1/sessions?projectId=${apiProjects.find((p: any) => p.isDefault).id}`)).json();
    console.log(JSON.stringify({ preClose: Date.now(), phase: "restart", abortSSE: "no browser connected yet" }));
    await app.close();
    app = await startServer({ ...config, cwd: cwdB });
    const afterRestart = await (await fetch("http://127.0.0.1:5258/v1/projects")).json();
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart.find((p: any) => p.isDefault).cwd).toBe(cwdB);
    const projectA = afterRestart.find((p: any) => p.cwd === cwdA);
    expect(projectA.isDefault).toBe(false);
    const historicalA = await (await fetch(`http://127.0.0.1:5258/v1/sessions?projectId=${projectA.id}`)).json();
    expect(historicalA[0].id).toBe(originalA[0].id);
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
    await expect(page.getByTestId("project-select")).toBeVisible();
    mkdirSync("/tmp/pi-project-discovery", { recursive: true });
    await page.getByTestId("project-select").click();
    await expect(page.getByRole("menuitemradio", { name: "workspace-a", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "默认项目", exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/pi-project-discovery/two-workspaces-dropdown.png", fullPage: true });
    await page.keyboard.press("Escape");
    for (const name of ["workspace-a", "workspace-b"]) {
      await page.getByTestId("project-select").click();
      await expect(page.getByRole("menuitemradio", { name: "excluded", exact: true })).toHaveCount(0);
      await page.getByRole("menuitemradio", { name: name === "workspace-b" ? "默认项目" : name, exact: true }).click();
      const row = page.getByRole("button", { name: `${name} history`, exact: true });
      await expect(row).toBeVisible(); await row.click();
      await expect(page.locator(".message-user")).toContainText(`${name} history`);
      if (name === "workspace-a") {
        await expect(page.getByTestId("new-session")).toBeEnabled();
      } else await expect(page.getByTestId("new-session")).toBeEnabled();
      await expect(page.getByTestId("composer-input")).toBeEnabled();
      await page.getByTestId("composer-input").fill(`continue ${name}`);
      await page.getByTestId("send-button").click();
      await expect(page.locator(".message-assistant").last()).toContainText("离线模型继续完成");
    }
    await page.getByTestId("project-select").click();
    await page.getByRole("menuitemradio", { name: "workspace-a", exact: true }).click();
    await page.getByTestId("new-session").click();
    await page.getByTestId("composer-input").fill("shared project private first send");
    await page.getByTestId("send-button").click();
    await expect(page.locator(".message-assistant").last()).toContainText("离线模型继续完成");
    const actorSessions = await (await fetch(`http://127.0.0.1:5258/v1/sessions?projectId=${projectA.id}`)).json();
    const privateSession = actorSessions.find((s: any) => s.ownerKey === "ip:127.0.0.1");
    expect(privateSession).toBeTruthy();
    const bCreate = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "127.0.0.2", payload: { projectId: projectA.id } });
    expect(bCreate.statusCode).toBe(201);
    const bPrivate = bCreate.json();
    const upload = (actor: string, projectId: string) => app!.inject({ method: "POST", url: "/v1/files", remoteAddress: actor,
      headers: { "content-type": "application/octet-stream", "x-upload-project-id": projectId,
        "x-upload-key": `attachment-${actor}`, "x-upload-name": "fixture.txt", "x-upload-kind": "text", "x-upload-type": "text/plain" }, payload: Buffer.from("private attachment") });
    const aFile = await upload("127.0.0.1", projectA.id); expect(aFile.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/v1/sessions/${bPrivate.id}/messages`, remoteAddress: "127.0.0.2",
      payload: { requestId: "foreign-file", prompt: "no", fileIds: [aFile.json().fileId] } })).statusCode).toBe(404);
    const bFile = await upload("127.0.0.2", projectA.id); expect(bFile.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/v1/sessions/${bPrivate.id}/messages`, remoteAddress: "127.0.0.2",
      payload: { requestId: "own-file", prompt: "own attachment", fileIds: [bFile.json().fileId] } })).statusCode).toBe(202);
    writeFileSync(path.join(cwdA, "fixture.txt"), "shared workspace file");
    expect((await app.inject({ method: "GET", url: `/v1/sessions/${privateSession.id}/file-preview?path=fixture.txt`, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/sessions/${privateSession.id}/file-preview?path=fixture.txt`, remoteAddress: "127.0.0.2" })).statusCode).toBe(404);
    const claimsDb = new DatabaseSync(dbPath);
    try {
      const rows = claimsDb.prepare("SELECT owner_key, visibility, conversation_ref FROM sessions WHERE id IN (?, ?)").all(privateSession.id, bPrivate.id) as any[];
      expect(rows).toHaveLength(2);
      for (const row of rows) { expect(row.visibility).toBe("private"); expect(path.dirname(row.conversation_ref)).toBe(path.join(source, nativeProjectDirectory(cwdA))); }
      expect(claimsDb.prepare("SELECT COUNT(*) AS n FROM native_session_sources WHERE session_id IN (?, ?)").get(privateSession.id, bPrivate.id)?.n).toBe(2);
    } finally { claimsDb.close(); }
    const privateOnlyCwd = path.join(root, "private-only"); mkdirSync(privateOnlyCwd);
    const privateProject = await app.inject({ method: "POST", url: "/v1/projects", remoteAddress: "127.0.0.1", payload: { name: "private-only", cwd: privateOnlyCwd } });
    expect((await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "127.0.0.2", payload: { projectId: privateProject.json().id } })).statusCode).toBe(404);
    expect((await upload("127.0.0.2", privateProject.json().id)).statusCode).toBe(404);
    const otherList = await app.inject({ method: "GET", url: `/v1/sessions?projectId=${projectA.id}`, remoteAddress: "127.0.0.2" });
    expect(otherList.json().some((s: any) => s.id === privateSession.id)).toBe(false);
    expect((await app.inject({ method: "GET", url: `/v1/sessions/${privateSession.id}/export`, remoteAddress: "127.0.0.2" })).statusCode).toBe(404);
    mkdirSync("/tmp/shared-project-private-create", { recursive: true });
    await page.screenshot({ path: "/tmp/shared-project-private-create/first-send.png", fullPage: true });
    mkdirSync("/tmp/pi-project-discovery", { recursive: true });
    await page.screenshot({ path: "/tmp/pi-project-discovery/two-workspaces-history.png", fullPage: true });
    await page.getByTestId("project-select").click();
    await page.getByTestId("new-project").click();
    await page.getByTestId("project-name-input").fill("New draft");
    await page.getByTestId("project-cwd-input").fill(draft);
    await page.getByTestId("project-create-submit").click();
    await expect(page.getByTestId("project-select")).toContainText("New draft");
    await expect(page.getByTestId("new-session")).toBeEnabled();
    await page.getByTestId("composer-input").fill("draft first send");
    await page.getByTestId("send-button").click();
    await expect(page.locator(".message-assistant").last()).toContainText("离线模型继续完成");
    await page.screenshot({ path: "/tmp/pi-project-discovery/new-project-first-send.png", fullPage: true });
    expect(posts).toEqual([202, 202, 202, 202]);
    expect(isolation.blocked).toEqual([]);
    expect(isolation.selections.filter(row => row.operation === "streamSimple")).toHaveLength(5);
    await page.screenshot({ path: "/tmp/pi-project-discovery/final.png", fullPage: true });
    await page.goto("about:blank");
    await app.close();
    app = await startServer({ ...config, cwd: cwdB, sessionShareExcludeCwds: [excluded, cwdA] });
    const excludedProjects = (await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "127.0.0.3" })).json();
    expect(excludedProjects.some((p: any) => p.id === projectA.id)).toBe(false);
    expect((await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "127.0.0.3", payload: { projectId: projectA.id } })).statusCode).toBe(404);
    expect((await upload("127.0.0.3", projectA.id)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/sessions/${privateSession.id}/export`, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "127.0.0.1", payload: { projectId: projectA.id } })).statusCode).toBe(201);
    expect((await upload("127.0.0.1", projectA.id)).statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: `/v1/sessions/${bPrivate.id}`, remoteAddress: "127.0.0.2" })).statusCode).toBe(204);
    const tombstoneDb = new DatabaseSync(dbPath);
    try { expect(tombstoneDb.prepare("SELECT deleted FROM native_session_sources WHERE session_id = ?").get(bPrivate.id)?.deleted).toBe(1); } finally { tombstoneDb.close(); }
    writeFileSync("/tmp/pi-project-discovery/evidence.json", JSON.stringify({ apiProjects, afterRestart, fixtureOnly: true, source, posts, selections: isolation.selections, blockedNetwork: isolation.blocked, checks: "A->B history, fixture-only model/SSE POST202, shared-project private first send, actor isolation, A/B same encoded directory with source claims, owner-only attachment send, own project preview, private-only guessed create/upload denied, exclude shared entry revoked/private retained, deletion tombstone, explicit draft first send" }, null, 2));
  } finally {
    // Destroy the browser's streaming fetch before closing HTTP; no misleading reconnect refusal.
    await page.goto("about:blank");
    console.log(JSON.stringify({ preClose: Date.now(), phase: "final", abortSSE: "browser navigated to about:blank" }));
    try { await app?.close(); } finally { isolation.restore(); rmSync(root, { recursive: true, force: true }); }
  }
});
