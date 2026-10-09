// Real SDK 1.1.0, explicit temporary resources/credentials, synthetic stream only.
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { join } from "node:path";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";

export async function steeringSdkFixture(root: string, configure?: (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => void) {
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
  await runtime.setRuntimeApiKey("openai", "offline-not-a-real-key");
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Isolated offline steering fixture", getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  let release = () => {};
  let calls = 0;
  let waits = 0;
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime: runtime,
    model: getModel("openai", "gpt-4o")!, thinkingLevel: "off", resourceLoader: loader, tools: ["subagent_wait"],
    sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    customTools: [{ name: "subagent_wait", label: "Wait", description: "Offline gated tool",
      parameters: { type: "object", properties: {}, additionalProperties: false } as any,
      execute: async (_id, _args, signal) => {
        waits++;
        await new Promise<void>(resolve => {
          release = resolve;
          if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { content: [{ type: "text" as const, text: "offline released" }], details: {} };
      } }],
  });
  // Override before adapter captures the original stream gate. No real provider can be invoked.
  session.agent.streamFunction = (model) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const message: any = { role: "assistant", content: [
      { type: "text", text: calls === 1 ? "主任务执行中。" : "正在写代码，主任务继续。" },
      { type: "toolCall", id: `wait-${calls}`, name: "subagent_wait", arguments: {} }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
    stream.push({ type: "done", reason: "toolUse", message }); stream.end(message); return stream;
  };
  configure?.(session);
  const adapter = new PiAgentAdapter(session as unknown as AgentSessionLike);
  return { session, adapter, release: () => release(), calls: () => calls, waits: () => waits };
}
