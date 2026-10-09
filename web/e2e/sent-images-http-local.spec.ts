import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildApp } from "../../src/server/app.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../../tests/helpers/ip-access.js";

// Same generated PNG as the accepted-send fixture; never reads user files or calls a model.
const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGP4n2ZMU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAIAlYFtUlL3ZAAAAAElFTkSuQmCC";

for (const count of [1, 2]) test(`real HTTP / SDK JSONL: ${count} images survive reselect and reload`, async ({ page }) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-images-http-"));
  const storage = await makeInitializedMemoryDb({ dataDir: root });
  const id = "image-sdk-history";
  const dir = path.join(root, "sessions", id);
  mkdirSync(dir, { recursive: true });
  const manager = SessionManager.create(root, dir);
  const text = count === 2 ? "文字和两张图片" : "";
  manager.appendMessage({ role: "user", content: [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...Array.from({ length: count }, () => ({ type: "image" as const, mimeType: "image/png", data: png })),
  ], timestamp: 1 });
  const file = manager.getSessionFile()!;
  const before = readFileSync(file, "utf8");
  for (const sessionId of [id, "other-images"]) await storage.sessions.create({
    id: sessionId, ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }),
    projectId: DEFAULT_PROJECT_ID, title: sessionId, createdAt: 1, updatedAt: 1,
    agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: sessionId === id ? file : null,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
  });
  const registry = new ConversationStorageRegistry();
  registry.register(new PiJsonlConversationStorage(root));
  // Read-only browser prevents SSE from opening a runtime; exports use the real JSONL reader.
  const app = buildApp({ sessions: storage.sessions, projects: storage.projects,
    defaultProjectCwd: root, ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "127.0.0.1", role: "viewer" }]) }),
    conversationStorage: registry, createAdapter: async () => new MockAgentAdapter([]) });
  try {
    await app.listen({ host: "127.0.0.1", port: 5208 });
    const response = await fetch(`http://127.0.0.1:5208/v1/sessions/${id}/export`);
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.messages[0].images).toEqual(Array.from({ length: count }, () => ({ mediaType: "image/png", base64: png })));
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    const images = page.locator(".message-images img");
    const select = async (sessionId: string) => {
      const button = page.locator(`.session-select[data-testid="session-${sessionId}"]`);
      await button.hover();
      expect(await button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === element;
      })).toBe(true);
      await button.click();
    };
    const verify = async () => {
      await expect(images).toHaveCount(count);
      for (const image of await images.all()) {
        await expect(image).toHaveAttribute("src", `data:image/png;base64,${png}`);
        expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(32);
      }
    };
    await select(id);
    await verify();
    await select("other-images");
    await expect(images).toHaveCount(0);
    await select(id);
    await verify();
    await page.reload();
    await select(id);
    await verify();
    await page.screenshot({ path: `/tmp/sent-image-fix/http-restored-${count}.png`, fullPage: true });
    await page.getByRole("button", { name: `预览图片 ${count}`, exact: true }).click();
    await expect(page.getByRole("dialog", { name: "图片预览" }).locator("img")).toHaveAttribute("src", `data:image/png;base64,${png}`);
    await page.screenshot({ path: `/tmp/sent-image-fix/http-preview-${count}.png` });
    expect(readFileSync(file, "utf8")).toBe(before);
  } finally {
    await app.close();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
