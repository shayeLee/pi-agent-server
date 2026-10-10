import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../src/server/app.js";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import type { AgentSdkEvent, SseEvent } from "../../src/agent/events.js";
import { SUBAGENT_HOST_TRANSPORT_EVENT, type SubagentHostTransport, type ExtensionCustomMessage } from "../../src/agent/subagent-host-transport.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../../tests/helpers/sqlite.js";
import { makeTestIpAccess } from "../../tests/helpers/ip-access.js";

type Evidence = { status: number; contentType: string | null; frames: string[] };

test("host post: completed user → idle notification → new HTTP SSE request; active keeps owned request", async ({ page }) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-host-followup-"));
  const artifacts = "/tmp/loop-turn-stats";
  mkdirSync(artifacts, { recursive: true });
  const storage = await makeInitializedMemoryDb({ dataDir: root });
  await storage.sessions.create({ id: "host-followup", title: "", ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }), projectId: DEFAULT_PROJECT_ID,
    createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  const listeners = new Set<(event: AgentSdkEvent) => void>();
  const emit = (event: AgentSdkEvent) => { for (const listener of listeners) listener(event); };
  const branch: any[] = [];
  const users: string[] = [];
  const custom: ExtensionCustomMessage[] = [];
  let streaming = false;
  let measurementClock = 0;
  let starts = 0;
  let release = () => {};
  const append = (entry: any) => {
    const row = { id: randomUUID(), parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...entry };
    branch.push(row);
    return row;
  };
  const run = async () => {
    starts++; streaming = true; emit({ type: "agent_start" }); emit({ type: "turn_start" });
    await new Promise<void>(resolve => { release = resolve; });
    streaming = false;
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    emit({ type: "agent_settled" });
  };
  const session: AgentSessionLike = {
    getSessionStats: () => ({ tokens: { input: 100, output: 42, cacheRead: 10, cacheWrite: 0, total: 152 }, cost: 0 }),
    getContextUsage: () => ({ tokens: 152, contextWindow: 1000, percent: 15.2 }),
    messages: [], sessionManager: { getBranch: () => branch, getEntries: () => branch,
      appendCustomEntry: (customType, data) => append({ type: "custom", customType, data }).id }, get isStreaming() { return streaming; },
    prompt: async text => { users.push(text); append({ type: "message", message: { role: "user", content: text, timestamp: Date.now() } }); await run(); },
    sendCustomMessage: async (message, options) => {
      expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      custom.push(message); append({ type: "custom_message", ...message });
      if (!streaming) await run(); // Streaming SDK custom is queued inside the already-owned run.
    },
    abort: async () => { release(); }, clearQueue: () => ({ steering: [], followUp: [] }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    steer: async () => {}, followUp: async () => {}, navigateTree: async () => {},
    setModel: async () => {}, setThinkingLevel: () => {}, dispose: () => { release(); },
  };
  let transport!: SubagentHostTransport;
  const handlers = new Map<string, (data: unknown) => void>();
  const adapter = new PiAgentAdapter(session, undefined, { on: (channel, handler) => {
    handlers.set(channel, handler); return () => { handlers.delete(channel); };
  } }, () => measurementClock);
  // Fake extension handshake only; the adapter bridge and runtime binding are production code.
  handlers.get(SUBAGENT_HOST_TRANSPORT_EVENT)!({ version: 1, accept: (value: SubagentHostTransport) => { transport = value; } });
  const app = buildApp({ sessions: storage.sessions, projects: storage.projects, defaultProjectCwd: root,
    ipAccess: makeTestIpAccess(), createAdapter: async () => adapter });
  const http: { method: string; url: string; body: unknown }[] = [];
  page.on("request", request => {
    if (request.url().includes("/v1/sessions/host-followup")) http.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
  });
  // Observe (never replace) the exact fetch response consumed by the UI, including proxy SSE chunks.
  await page.addInitScript(() => {
    const state = globalThis as unknown as { __hostEvidence: Evidence[] };
    state.__hostEvidence = [];
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes("/sessions/host-followup/events") && response.body) {
        const evidence: Evidence = { status: response.status, contentType: response.headers.get("content-type"), frames: [] };
        state.__hostEvidence.push(evidence);
        const reader = response.clone().body!.getReader();
        void (async () => {
          let pending = ""; const decoder = new TextDecoder();
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              pending += decoder.decode(chunk.value, { stream: true });
              let end: number;
              while ((end = pending.indexOf("\n\n")) >= 0) {
                evidence.frames.push(pending.slice(0, end)); pending = pending.slice(end + 2);
              }
            }
          } catch { /* Normal navigation/connection close. */ }
        })();
      }
      return response;
    };
  });
  const evidence = () => page.evaluate(() => (globalThis as unknown as { __hostEvidence: Evidence[] }).__hostEvidence);
  const events = async (): Promise<SseEvent[]> => (await evidence()).flatMap(stream => stream.frames.flatMap(frame => {
    const data = frame.split("\n").find(line => line.startsWith("data: "));
    return data ? [JSON.parse(data.slice(6)) as SseEvent] : [];
  }));
  const completed = async (id: string) => (await events()).filter(event => event.type === "completed" && event.requestId === id).length;
  const reply = (text: string, toolId?: string) => {
    emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
    if (toolId) {
      emit({ type: "tool_execution_start", toolCallId: toolId, toolName: "subagent_wait", args: { runIds: ["run31"] } });
      emit({ type: "tool_execution_update", toolCallId: toolId, toolName: "subagent_wait", args: {}, partialResult: { content: [{ type: "text", text: "正在收集后台结果" }] } });
    }
  };
  const notify = async (text: string) => {
    const payload = { version: 1 as const, notificationId: randomUUID(), runIds: ["run31"], text };
    const row = append({ type: "custom", customType: "agent-team:notification", data: payload });
    emit({ type: "entry_appended", entry: row } as any);
    const ack = await transport.post(payload);
    expect(await transport.post(payload)).toEqual(ack);
    return { payload, ack };
  };
  try {
    await app.listen({ host: "127.0.0.1", port: 5248 });
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
    await page.getByTestId("session-host-followup").click();
    await page.getByTestId("composer-input").fill("真正用户任务完成后检查后台结果");
    await page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => starts).toBe(1);
    reply("原始任务已完成。"); release();
    const userRequest = () => http.find(request => request.method === "POST" && request.url.endsWith("/messages"))?.body as { requestId: string };
    await expect.poll(() => userRequest()?.requestId).toBeTruthy();
    const originalId = userRequest().requestId;
    await expect.poll(() => completed(originalId)).toBe(1);
    await expect(page.getByTestId("stat-live")).toHaveCount(0);

    const idle = await notify("后台 run31 已完成，等待收集。宿主 idle 自动跟进。");
    expect(idle.ack).toMatchObject({ accepted: true, mode: "run" });
    if (!idle.ack.accepted) throw new Error("idle admission rejected");
    const idleId = idle.ack.requestId;
    expect(idleId).not.toBe(originalId); expect(idleId).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(() => starts).toBe(2);
    reply("宿主自动跟进：正在读取后台结果。", "idle-tool");
    await expect(page.getByTestId("subagent-notification")).toHaveCount(1);
    await expect(page.locator(".message-assistant")).toContainText(["原始任务已完成。", "宿主自动跟进"]);
    await expect(page.getByText("正在收集后台结果", { exact: true }).first()).toBeVisible();
    emit({ type: "tool_execution_end", toolCallId: "idle-tool", toolName: "subagent_wait", result: { content: [{ type: "text", text: "run31 结果已收集" }] }, isError: false });
    reply("后台结果已收集，自动跟进完成。"); release();
    await expect.poll(() => completed(idleId)).toBe(1);
    await expect(page.getByTestId("stat-live")).toHaveCount(0);
    await expect(page.locator(".message-user")).toHaveCount(1);
    await expect(page.getByTestId("stat-turns")).toHaveText("2 轮");
    await expect(page.getByTestId("stat-model-turns")).toHaveText("2 turn");
    expect(await page.getByTestId("subagent-notification").evaluate(el => !!el.closest(".message-user, .message-assistant"))).toBe(false);
    expect(users).toEqual(["真正用户任务完成后检查后台结果"]);
    expect(custom).toHaveLength(1);
    expect(http.filter(request => request.method === "POST" && request.url.endsWith("/messages"))).toHaveLength(1);

    // Contrast: a notification during streaming does not create a host task/model start.
    await page.getByTestId("composer-input").fill("活动任务对照"); await page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => starts).toBe(3);
    const activeRequest = http.filter(request => request.method === "POST" && request.url.endsWith("/messages")).at(-1)!.body as { requestId: string };
    reply("活动任务正在处理。");
    const active = await notify("后台结果追加到活动任务，保留同一 requestId。");
    expect(active.ack).toEqual({ accepted: true, mode: "followUp", requestId: activeRequest.requestId });
    expect(starts).toBe(3);
    emit({ type: "turn_end" }); emit({ type: "turn_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
    reply("活动 follow-up 同一请求可见。", "active-tool");
    emit({ type: "tool_execution_end", toolCallId: "active-tool", toolName: "subagent_wait", result: "活动结果已收集", isError: false });
    measurementClock = 100;
    emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 42, cacheRead: 10, cacheWrite: 0, totalTokens: 152, cost: { total: 0 } } } });
    release(); await expect.poll(() => completed(activeRequest.requestId)).toBe(1);
    await expect(page.getByTestId("stat-summary-speed")).toHaveText("420 tok/s");
    await expect(page.locator(".message-user")).toHaveCount(2);
    await expect(page.getByTestId("stat-turns")).toHaveText("3 轮");
    await expect(page.getByTestId("stat-model-turns")).toHaveText("4 turn");
    await expect(page.getByTestId("stat-steps")).toHaveText("工具 2 次");
    await expect(page.getByTestId("subagent-notification")).toHaveCount(2);
    await expect(page.locator(".message-assistant").last()).toContainText("活动 follow-up 同一请求可见。");
    const captured = await events();
    for (const [notificationId, requestId, toolId] of [[idle.payload.notificationId, idleId, "idle-tool"], [active.payload.notificationId, activeRequest.requestId, "active-tool"]]) {
      const notices = captured.filter(event => event.type === "notification" && event.notificationId === notificationId);
      expect(notices).toHaveLength(1); expect(notices[0]).not.toHaveProperty("requestId");
      const lifecycle = captured.filter(event => event.requestId === requestId);
      expect(lifecycle.filter(event => ["completed", "aborted", "error"].includes(event.type))).toEqual([{ type: "completed", requestId }]);
      for (const type of ["tool_start", "tool_update", "tool_end"]) expect(lifecycle.some(event => event.type === type && "toolCallId" in event && event.toolCallId === toolId)).toBe(true);
      expect(lifecycle.some(event => event.type === "text_delta")).toBe(true);
      expect(captured.find(event => "toolCallId" in event && event.toolCallId === toolId)?.requestId).toBe(requestId);
    }
    expect(await completed(originalId)).toBe(1);
    expect((await evidence()).every(stream => stream.status === 200 && stream.contentType?.includes("text/event-stream"))).toBe(true);
    writeFileSync(path.join(artifacts, "http-sse-evidence.json"), JSON.stringify({ originalId, idleAck: idle.ack, activeAck: active.ack, sdk: { starts, users, custom }, http, streams: await evidence(), events: captured }, null, 2));
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
      await page.evaluate(value => document.querySelector(".app-shell")!.setAttribute("data-theme", value), theme);
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await expect.poll(async () => {
        const box = await page.getByTestId("sidebar").boundingBox(); return box ? box.x + box.width : 0;
      }).toBeLessThanOrEqual(0);
      await page.getByTestId("subagent-notification").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, `${theme}-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByTestId("stat-summary-speed")).toBeVisible();
      const statsBox = await page.getByTestId("stats-bar").boundingBox();
      const composerBox = await page.getByTestId("composer-input").boundingBox();
      expect(statsBox!.y).toBeGreaterThan(composerBox!.y);
      await page.getByRole("button", { name: "查看统计详情" }).click();
      await expect(page.getByText("用户消息 2 条")).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, `${theme}-${width}-details.png`), fullPage: true });
      await page.getByRole("button", { name: "关闭对话框" }).click();
    }
  } finally { release(); await app.close(); await storage.close(); rmSync(root, { recursive: true, force: true }); }
});
