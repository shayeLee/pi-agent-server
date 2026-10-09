// Real SDK, offline stream, fake children: never load global extensions or spawn Pi.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import type { SseEvent } from "../../src/agent/events.js";

async function fixture(root: string) {
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "offline-not-a-real-key");
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Offline cancellation fixture", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  let finishChild!: () => void;
  const child = new Promise<void>(resolve => { finishChild = resolve; });
  let childStatus = "running";
  let waitSignal: AbortSignal | undefined;
  const stop = vi.fn(() => { childStatus = "stopped"; finishChild(); });
  const parameters = { type: "object", properties: {}, additionalProperties: false } as any;
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime,
    model: getModel("openai", "gpt-4o")!, thinkingLevel: "off", resourceLoader,
    tools: ["subagent_wait", "subagent_stop"], sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    customTools: [
      { name: "subagent_wait", label: "Wait", description: "Wait without owning the fake child", parameters,
        execute: async (_id, _args, signal) => {
          waitSignal = signal;
          let cancel!: () => void;
          const cancelled = new Promise<void>(resolve => { cancel = resolve; });
          if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
          try { await Promise.race([child, cancelled]); }
          finally { signal?.removeEventListener("abort", cancel); }
          return { content: [{ type: "text" as const, text: signal?.aborted ? "Wait aborted; child still running" : childStatus }], details: {} };
        } },
      { name: "subagent_stop", label: "Stop", description: "Explicitly stop the fake child", parameters,
        execute: async () => { stop(); return { content: [{ type: "text" as const, text: "stopped" }], details: {} }; } },
    ],
  });
  let calls = 0;
  let nextTool = "subagent_wait";
  session.agent.streamFunction = model => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const tool = nextTool; nextTool = "";
    const message: any = { role: "assistant", content: tool ? [{ type: "toolCall", id: `tool-${calls}`, name: tool, arguments: {} }] : [{ type: "text", text: "done" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(message); return stream;
  };
  const adapter = new PiAgentAdapter(session as unknown as AgentSessionLike);
  const events: SseEvent[] = [];
  const concurrency = new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, perUserQueueLimit: 2, globalQueueLimit: 2, queueTimeoutMs: 5000 });
  const runtime = new SessionRuntime({ sessionId: "isolated", ownerKey: "owner", adapter, concurrency, now: Date.now, onEvent: event => events.push(event) });
  return { session, runtime, events, concurrency, stop, child, calls: () => calls, signal: () => waitSignal,
    status: () => childStatus, complete: () => { childStatus = "completed"; finishChild(); },
    explicitStop: () => { nextTool = "subagent_stop"; } };
}

describe("real SDK primary cancellation with independent background children", () => {
  it.each(["complete", "explicitStop"] as const)("abort releases wait and primary slot; child ends only by %s", async outcome => {
    const root = await mkdtemp(join(tmpdir(), "subagent-abort-sdk-"));
    const f = await fixture(root);
    try {
      let childSettled = false;
      void f.child.then(() => { childSettled = true; });
      await f.runtime.submitMessage({ requestId: "primary", userId: "owner", prompt: "wait" });
      await vi.waitFor(() => expect(f.signal()).toBeDefined());
      expect(f.concurrency.activeCount()).toBe(1);
      expect(await f.runtime.abort("primary")).toEqual({ kind: "ok" });
      await vi.waitFor(() => expect(f.concurrency.activeCount()).toBe(0));
      expect(f.signal()?.aborted).toBe(true);
      expect(f.session.isIdle).toBe(true);
      expect(childSettled).toBe(false);
      expect(f.status()).toBe("running");
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.calls()).toBe(1); // Abort must not resume primary after tool returns.
      expect(f.events.filter(e => e.type === "aborted")).toEqual([{ type: "aborted", requestId: "primary" }]);
      expect(f.events.some(e => e.type === "completed")).toBe(false);
      expect(f.events.filter(e => e.type === "tool_end")).toHaveLength(1);
      if (outcome === "complete") {
        f.complete(); await f.child;
        expect(f.status()).toBe("completed");
        expect(f.calls()).toBe(1);
      } else {
        f.explicitStop();
        await f.runtime.submitMessage({ requestId: "explicit-stop", userId: "owner", prompt: "stop child" });
        await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(f.concurrency.activeCount()).toBe(0));
        expect(f.status()).toBe("stopped");
      }
    } finally { f.runtime.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
