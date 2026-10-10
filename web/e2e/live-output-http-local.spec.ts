import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { buildApp } from "../../src/server/app.js";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makeTestIpAccess } from "../../tests/helpers/ip-access.js";

// Business flow representatives: light desktop and dark mobile, not the full cross-product.
for (const { theme, width } of [{ theme: "light", width: 1280 }, { theme: "dark", width: 390 }] as const) test(`real App/adapter HTTP SSE live output ${theme} ${width}`, async ({ page }) => {
  await mkdir("/tmp/stats-single-line",  { recursive: true });
  const storage = await makeInitializedMemoryDb({ cwd: "/tmp/live-output-speed" });
  const ownerKey = identityKey({ kind: "ip", ip: "127.0.0.1" });
  for (const id of ["live-model", "other-model"]) await storage.sessions.create({ id, ownerKey, projectId: DEFAULT_PROJECT_ID, title: id,
    createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  let clock = 0; let finish = () => {}; let started = 0;
  const listeners = new Set<(event: AgentSdkEvent) => void>();
  const emit = (event: AgentSdkEvent) => { for (const listener of listeners) listener(event); };
  const start = () => emit({ type: "message_start", message: { role: "assistant" } });
  const delta = (type: "text_delta" | "thinking_delta" | "toolcall_delta", text: string) => emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type, contentIndex: 0, delta: text } });
  const usage = { input: 10, output: 42, cacheRead: 0, cacheWrite: 0, totalTokens: 52, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const end = () => emit({ type: "message_end", message: { role: "assistant", usage } });
  const session: AgentSessionLike = { messages: [],
    prompt: async () => { started++; emit({ type: "agent_start" }); start(); await new Promise<void>(resolve => { finish = resolve; }); },
    abort: async () => { finish(); }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    steer: async () => {}, followUp: async () => {}, navigateTree: async () => {}, setModel: async () => {}, setThinkingLevel: () => {}, dispose: () => {} };
  const createAdapter = async () => new PiAgentAdapter(session, undefined, undefined, () => clock);
  const concurrency = new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 4, perUserQueueLimit: 4, queueTimeoutMs: 10000 });
  const registry = new RuntimeRegistry({ concurrency, createAdapter });
  const app = buildApp({ sessions: storage.sessions, projects: storage.projects, defaultProjectCwd: "/tmp/live-output-speed", ipAccess: makeTestIpAccess(), createAdapter, registry, concurrency });
  try {
    await app.listen({ host: "127.0.0.1", port: 8096 });
    await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: theme }); await page.goto("/");
    const select = async (id: string) => {
      if (width === 390) await page.getByRole("button", { name: "打开工作区导航" }).click();
      await page.getByTestId(`session-${id}`).click({ position: { x: 15, y: 12 } });
      if (width === 390) await expect.poll(async () => {
        const box = await page.getByTestId("sidebar").boundingBox();
        return box ? box.x + box.width : 0;
      }).toBeLessThanOrEqual(0);
    };
    await select("live-model");
    await page.getByTestId("composer-input").fill("隔离测试，不调用真实模型");
    await page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => started).toBe(1);
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    delta("thinking_delta", "想".repeat(100)); clock = 500; delta("thinking_delta", "想".repeat(100));
    await expect(page.getByTestId("stat-live-speed")).toHaveText("~100 tok/s");
    await expect.poll(() => page.getByTestId("stats-bar").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-active.png` });
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0, { timeout: 4000 });
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-pause.png` });
    end(); emit({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "fixture only" } });
    emit({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "tool result must not count" }] } });
    await expect(page.getByTestId("stats-bar")).not.toContainText("工具执行中");
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-tool.png` });
    clock = 10000; start(); delta("toolcall_delta", "x".repeat(100)); clock = 10500; delta("text_delta", "继续输出".repeat(25));
    // Actual model delta takes precedence even while tool lifecycle is still open.
    await expect(page.getByTestId("stat-live-speed")).toContainText("~100 tok/s");
    await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-resumed.png` });
    const reconnected = page.waitForResponse(response => response.url().includes('/events'));
    registry.get("live-model")!.events.closeAll();
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    // A delta produced while disconnected is delivered as replay, not fresh activity.
    // It also gives the Vite proxy a body chunk (headers alone can remain buffered).
    clock = 10625; delta("text_delta", "补发数据");
    await reconnected;
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    clock = 10875; delta("text_delta", "收到新数据".repeat(20));
    await expect(page.getByTestId("stat-live-speed")).toContainText("~");
    emit({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: "done", isError: false });
    clock = 11000; end(); finish();
    await expect(page.getByTestId("stat-live")).toHaveCount(0);
    await expect(page.getByTestId("stat-summary-speed")).toHaveText("42 tok/s");
    await page.screenshot({ path: `/tmp/stats-single-line/${theme}-${width}-final.png` });
    await page.getByTestId("composer-input").fill("abort fixture"); await page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => started).toBe(2); delta("text_delta", "before abort"); clock += 500; delta("text_delta", "after delay");
    await expect(page.getByTestId("stat-live-speed")).toBeVisible(); await page.getByTestId("abort-button").click();
    await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    await select("other-model"); await expect(page.getByTestId("stat-live")).toHaveCount(0);
    await select("live-model"); await expect(page.getByTestId("stat-live-speed")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { finish(); await app.close(); await storage.close(); }
});
