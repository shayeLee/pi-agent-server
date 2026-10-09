import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { steeringSdkFixture } from "./steering-sdk-fixture.js";
import { applySseEvent, createChatState } from "../../src/client/chat-state.js";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { resolveHostToolSelection } from "../../src/agent/tool-selection.js";
import { translateSdkEvent } from "../../src/agent/translate.js";
import { projectExportSnapshot } from "../../src/agent/session-export.js";

describe("Pi 1.1 host contracts", () => {
  it("resolves modifiers in order, preserves all/empty/plain, rejects upstream invalid syntax", () => {
    expect(resolveHostToolSelection(undefined, undefined)).toBeUndefined();
    expect(resolveHostToolSelection([], undefined)).toEqual([]);
    expect(resolveHostToolSelection(["read", "ls"], undefined)).toEqual(["read", "ls"]);
    expect(resolveHostToolSelection(["+read", "-bash", "+custom"], undefined)).toEqual(["read", "edit", "write", "custom"]);
    expect(resolveHostToolSelection(["+custom", "-ls"], ["ls"])).toEqual(["custom"]);
    expect(resolveHostToolSelection(["+custom"], undefined, "all")).toEqual(["custom"]);
    expect(() => resolveHostToolSelection(["read", "+write"], undefined)).toThrow("cannot be mixed");
    expect(() => resolveHostToolSelection(["+*"], undefined)).toThrow("exact tool names");
    expect(resolveHostToolSelection(["unknown_legal_name"], undefined)).toEqual(["unknown_legal_name"]);
    expect(() => resolveHostToolSelection(["+fixture"], ["+bash"])).toThrow("resolved tools");
  });

  it.each(["++bash", "+-read", "-+read", "--bash"])("rejects repeated raw modifier %s before SDK reinterpretation", entry => {
    expect(() => resolveHostToolSelection(["-read", "-bash", "-edit", "-write", entry], undefined)).toThrow("repeated modifier");
  });

  it("capped SDK loadouts survive activation/reload/restore, delegation cannot escape, duration is SDK-measured", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi110-contract-")));
    const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
    try {
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
      await runtime.setRuntimeApiKey("openai", "offline-fixture");
      const loader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "Offline fixture", getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
      };
      const manager = SessionManager.inMemory(root);
      let nestedBlocked = false;
      const options = { cwd: root, agentDir: join(root, "agent"), modelRuntime: runtime, model: getModel("openai", "gpt-4o")!, resourceLoader: loader,
        sessionManager: manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
        tools: resolveHostToolSelection(["-read", "-bash", "-edit", "-write", "+fixture"], undefined),
        customTools: [{ name: "fixture", label: "Fixture", description: "Offline nested-call test", parameters: { type: "object", properties: {} } as any,
          execute: async (_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: any) => {
            try { const result = await ctx.executeTool("bash", { command: "exit 99" }); nestedBlocked = result.isError === true; } catch { nestedBlocked = true; }
            return { content: [{ type: "text" as const, text: "done" }], details: {} };
          } }],
      };
      const { session } = await createAgentSession(options); sessions.push(session);
      session.setActiveToolsByName(["fixture", "bash", "write"]);
      expect(session.getActiveToolNames()).toEqual(["fixture"]);
      await session.reload();
      expect(session.getActiveToolNames()).toEqual(["fixture"]);
      let calls = 0;
      session.agent.streamFunction = model => {
        const stream = createAssistantMessageEventStream();
        const first = calls++ === 0;
        const message: any = { role: "assistant", content: first ? [{ type: "toolCall", id: "fixture-call", name: "fixture", arguments: {} }] : [{ type: "text", text: "done" }],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: first ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
      };
      const ends: any[] = []; const settled: any[] = [];
      session.subscribe(event => { if (event.type === "tool_execution_end") ends.push(event); if (event.type === "agent_settled") settled.push(event); });
      await session.prompt("offline");
      expect(nestedBlocked).toBe(true);
      const toolEnd = ends.find(event => event.toolCallId === "fixture-call");
      expect(toolEnd.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(toolEnd.durationMs)).toBe(true);
      expect(translateSdkEvent(toolEnd)).toMatchObject({ durationMs: toolEnd.durationMs });
      const result = projectExportSnapshot([], manager.getBranch()).timeline.find(row => row.type === "tool_result");
      expect(result).toMatchObject({ durationMs: toolEnd.durationMs });
      expect(settled.at(-1).aborted).toBe(false);
      expect(translateSdkEvent(settled.at(-1))).toBeNull();
      const restored = await createAgentSession({ ...options, sessionManager: SessionManager.inMemory(root, undefined, [manager.getHeader()!, ...manager.getEntries()]) });
      sessions.push(restored.session);
      restored.session.setActiveToolsByName(["fixture", "bash"]);
      expect(restored.session.getActiveToolNames()).toEqual(["fixture"]);
    } finally { for (const session of sessions) session.dispose(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["server_busy", "servers are currently busy"])("new retry error %s counts real turns, cancellation stops continuation", async errorMessage => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi110-retry-")));
    let calls = 0;
    const f = await steeringSdkFixture(root, session => {
      vi.spyOn(session.settingsManager, "getRetrySettings").mockReturnValue({ enabled: true, maxRetries: 2, baseDelayMs: 20, maxAgentDelayMs: 100 });
      session.agent.streamFunction = model => {
        const stream = createAssistantMessageEventStream();
        const failed = calls++ === 0;
        const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage } : {}),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (failed) stream.push({ type: "error", reason: "error", error: message }); else stream.push({ type: "done", reason: "stop", message });
        stream.end(message); return stream;
      };
    });
    try {
      await f.adapter.prompt("retry offline");
      expect(calls).toBe(2);
      expect((await f.adapter.getUsageSnapshot()).execution).toMatchObject({ totalLoops: 1, totalTurns: 2 });
      calls = 0;
      const unsubscribe = f.session.subscribe(event => { if (event.type === "auto_retry_start") queueMicrotask(() => void f.adapter.abort()); });
      await f.adapter.prompt("cancel retry");
      unsubscribe();
      expect(calls).toBe(1);
      expect((await f.adapter.getUsageSnapshot()).execution).toMatchObject({ totalLoops: 2, totalTurns: 3 });
    } finally { f.adapter.dispose(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); }
  });

  it.each([undefined, null, 0, 12.5, -1, Infinity, NaN])("only exposes valid measured durations: %s", durationMs => {
    const event = translateSdkEvent({ type: "tool_execution_end", toolCallId: "t", toolName: "fixture", result: {}, isError: false, durationMs });
    if (durationMs === null || (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0)) expect(event).toHaveProperty("durationMs", durationMs);
    else expect(event).not.toHaveProperty("durationMs");
    const manager = SessionManager.inMemory("/offline-fixture");
    manager.appendMessage({ role: "toolResult", toolCallId: "t", toolName: "fixture", content: [], isError: false, timestamp: 0, durationMs } as any);
    const historical = projectExportSnapshot([], manager.getBranch()).timeline.find(row => row.type === "tool_result");
    if (durationMs === null || (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0)) expect(historical).toHaveProperty("durationMs", durationMs);
    else expect(historical).not.toHaveProperty("durationMs");
    const state = applySseEvent(createChatState(), { type: "tool_end", toolCallId: "t", toolName: "fixture", result: {}, isError: false, durationMs });
    const tool = state.timeline.find(row => row.kind === "tool")?.call;
    if (durationMs === null || (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0)) expect(tool).toHaveProperty("durationMs", durationMs);
    else expect(tool).not.toHaveProperty("durationMs");
  });
});
