import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildApp } from "../../src/server/app.js";
import { PiJsonlConversationStorage, openPiRuntimeSessionFile } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makeTestIpAccess } from "../../tests/helpers/ip-access.js";

const rawThinking = "真实 SDK 持久化思考\n第二行：恢复后必须能够展开读取。";

for (const live of [false, true]) {
  test(`${live ? "resumed runtime" : "cold JSONL"}: HTTP export → browser → reselect → reload`, async ({ page }) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-resume-http-"));
    const storage = await makeInitializedMemoryDb({ dataDir: root });
    const id = "web-index-id"; // Deliberately not the SDK header's sessionId.
    const dir = path.join(root, "sessions", id);
    mkdirSync(dir, { recursive: true });
    const manager = SessionManager.create(root, dir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "恢复测试" }], timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [
      { type: "thinking", thinking: rawThinking, thinkingSignature: "fixture-signature" },
      { type: "text", text: "恢复的回答" },
    ], api: "anthropic-messages", provider: "anthropic", model: "fixture-no-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2 });
    const file = manager.getSessionFile()!;
    const before = readFileSync(file, "utf8");
    expect(manager.getSessionId()).not.toBe(id);
    for (const sessionId of [id, "other-index-id"]) {
      await storage.sessions.create({ id: sessionId, ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }),
        projectId: DEFAULT_PROJECT_ID, title: sessionId, createdAt: 1, updatedAt: 1,
        agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: sessionId === id ? file : null,
        modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
    }
    const registry = new ConversationStorageRegistry();
    // Opt-in diagnostic exercises the existing compiled backend, without rebuilding it.
    const Reader = process.env.RESUME_DIAGNOSTIC_BACKEND === "dist"
      ? (await import("../../dist/agent/pi-jsonl-conversation-storage.js")).PiJsonlConversationStorage
      : PiJsonlConversationStorage;
    registry.register(new Reader(root));
    let adapterCreations = 0;
    const app = buildApp({ sessions: storage.sessions, projects: storage.projects,
      defaultProjectCwd: root, ipAccess: makeTestIpAccess(), conversationStorage: registry,
      createAdapter: async (sessionId) => {
        adapterCreations++;
        const adapter = new MockAgentAdapter([{ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false }]);
        if (sessionId !== id) return adapter; // The other session has no persisted history.
        const resumed = openPiRuntimeSessionFile(file);
        // Actual resumed SDK branch exported by production adapter; only model execution is mocked.
        const snapshotSession: AgentSessionLike = {
          messages: resumed.buildSessionContext().messages, sessionManager: resumed,
          subscribe: () => () => {}, dispose: () => {},
          prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {},
          navigateTree: async () => {}, setModel: async () => {}, setThinkingLevel: () => {},
        };
        const snapshotAdapter = new PiAgentAdapter(snapshotSession);
        try { adapter.exportData = await snapshotAdapter.exportSession(); }
        finally { snapshotAdapter.dispose(); }
        return adapter;
      },
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 8097 });
      if (live) {
        const response = await fetch(`http://127.0.0.1:8097/v1/sessions/${id}/messages`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: "mock-runtime-only", prompt: "do not call a model" }),
        });
        expect(response.status).toBe(202);
        await expect.poll(() => adapterCreations).toBe(1);
      }
      const requests: Array<{ id: string; cursor: string | undefined }> = [];
      page.on("request", (request) => {
        if (request.url().includes("/events")) requests.push({ id: new URL(request.url()).pathname,
          cursor: request.headers()["last-event-id"] });
      });
      await page.goto("/");
      const exported = page.waitForResponse((response) => response.url().endsWith(`/sessions/${id}/export`));
      await page.getByTestId(`session-${id}`).click({ position: { x: 15, y: 12 } });
      const response = await exported;
      expect(response.status()).toBe(200);
      const snapshot = await response.json();
      console.log(JSON.stringify({ backend: process.env.RESUME_DIAGNOSTIC_BACKEND ?? "source",
        frontend: process.env.RESUME_DIAGNOSTIC_FRONTEND ?? "source", live,
        fields: Object.keys(snapshot), timelineTypes: snapshot.timeline.map((item: { type: string }) => item.type),
        lastEventId: snapshot.lastEventId }));
      // Separate payload failure from frontend rendering failure.
      expect(snapshot.timeline.filter((item: { type: string }) => item.type === "thinking").map((item: { text: string }) => item.text)).toEqual([rawThinking]);
      const toggle = page.getByRole("button", { name: /思考过程/ });
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator(".thinking-body")).toHaveText(rawThinking);
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      expect(requests[0].cursor).toBe(String(snapshot.lastEventId));
      await page.getByTestId("session-other-index-id").click({ position: { x: 15, y: 12 } });
      await expect(toggle).toHaveCount(0);
      await page.getByTestId(`session-${id}`).click({ position: { x: 15, y: 12 } });
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator(".thinking-body")).toHaveText(rawThinking);
      await page.reload();
      await page.getByTestId(`session-${id}`).click({ position: { x: 15, y: 12 } });
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator(".thinking-body")).toHaveText(rawThinking);
      // Writable users' SSE GET lazily opens both selected sessions; export itself is read-only.
      expect(adapterCreations).toBe(2);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      await app.close();
      await storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
