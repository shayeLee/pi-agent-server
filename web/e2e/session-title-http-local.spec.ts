import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../src/server/app.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../../tests/helpers/ip-access.js";

test("isolated HTTP history: unselected sidebar, header, reselect, reload and explicit title agree", async ({ page }) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-title-http-"));
  const storage = await makeInitializedMemoryDb({ dataDir: root });
  const prompt = `第一条多行长文\n${"完整提示词仅视觉省略，后续消息不应覆盖。".repeat(50)}`;
  for (const [id, title, text] of [["old-title", "", prompt], ["image-title", "", ""], ["literal-title", "未命名会话", "这是提示词不是标题"]]) {
    const dir = path.join(root, "sessions", id!); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "fixture.jsonl");
    writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: `header-${id}`, cwd: root }),
      JSON.stringify({ type: "message", id: "first", parentId: null, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } }),
      JSON.stringify({ type: "message", id: "last", parentId: "first", message: { role: "user", content: "后续提示词不能改兜底", timestamp: 2 } }), ""].join("\n"));
    await storage.sessions.create({ id: id!, title: title!, ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }), projectId: DEFAULT_PROJECT_ID,
      createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: file,
      modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  }
  const registry = new ConversationStorageRegistry(); registry.register(new PiJsonlConversationStorage(root));
  const app = buildApp({ sessions: storage.sessions, projects: storage.projects, defaultProjectCwd: root,
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "127.0.0.1", role: "viewer" }]) }),
    conversationStorage: registry, createAdapter: async () => new MockAgentAdapter([]) });
  try {
    await app.listen({ host: "127.0.0.1", port: 5238 });
    const response = await fetch("http://127.0.0.1:5238/v1/sessions");
    expect((await response.json()).find((row: { id: string }) => row.id === "old-title")).toMatchObject({ title: "", firstPrompt: prompt });
    await page.setViewportSize({ width: 1400, height: 900 }); await page.goto("/");
    const old = page.getByTestId("session-old-title").locator(".session-title");
    await expect(old).toHaveAttribute("title", prompt); // Available before selection.
    const verify = async () => {
      await expect(page.getByTestId("chat-session-title")).toHaveAttribute("title", prompt);
      await expect(old).toHaveAttribute("title", prompt);
      expect(await old.evaluate((element) => element.textContent)).toBe(prompt);
      expect(await old.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    };
    await page.getByTestId("session-old-title").click(); await verify();
    await page.screenshot({ path: "/tmp/session-title-fallback/history-long.png", fullPage: true });
    await page.getByTestId("session-image-title").click();
    await expect(page.getByTestId("chat-session-title")).toHaveText("未命名会话");
    await page.getByTestId("session-old-title").click(); await verify();
    await page.reload(); await expect(old).toHaveAttribute("title", prompt);
    await page.getByTestId("session-old-title").click(); await verify();
    await storage.sessions.update("old-title", { title: "用户自设标题" });
    await page.reload(); await page.getByTestId("session-old-title").click();
    await expect(page.getByTestId("chat-session-title")).toHaveText("用户自设标题");
    await expect(old).toHaveText("用户自设标题");
    await page.screenshot({ path: "/tmp/session-title-fallback/explicit-title.png", fullPage: true });
    await page.getByTestId("session-literal-title").click();
    await expect(page.getByTestId("chat-session-title")).toHaveText("未命名会话");
  } finally { await app.close(); await storage.close(); rmSync(root, { recursive: true, force: true }); }
});
