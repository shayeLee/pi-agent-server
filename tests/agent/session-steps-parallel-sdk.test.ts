import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { readPiJsonlSteps } from "../../src/agent/pi-jsonl-conversation-storage.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("parallel tool result ordering through the real SDK", () => {
  it("retains completion order in steps while JSONL records calls in SDK order", async () => {
    const root = await mkdtemp(join(tmpdir(), "steps-parallel-sdk-"));
    const gateA = deferred();
    const gateB = deferred();
    const entered = new Set<string>();
    const completed = new Set<string>();
    const toolEnds: string[] = [];
    const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
    let modelRequests = 0;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let adapter: PiAgentAdapter | undefined;
    let running: Promise<void> | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
        refreshOnCreate: false, allowModelNetwork: false });
      await modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "Offline parallel SDK regression fixture", getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
      };
      const sessionManager = SessionManager.create(root, join(root, "sessions"));
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const tool = (name: "fixture_A" | "fixture_B", gate: ReturnType<typeof deferred>) => ({
        name, label: name, description: "Offline parallel regression tool",
        parameters: { type: "object", properties: {}, additionalProperties: false }, executionMode: "parallel" as const,
        execute: async (_id: string, _args: Record<string, never>, _signal: AbortSignal | undefined) => {
          entered.add(name);
          await gate.promise;
          completed.add(name);
          return { content: [{ type: "text" as const, text: name }], details: {} };
        },
      });
      const created = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime,
        model: getModel("openai", "gpt-4o")!, resourceLoader, sessionManager, settingsManager,
        tools: ["fixture_A", "fixture_B"], customTools: [tool("fixture_A", gateA), tool("fixture_B", gateB)] });
      session = created.session;
      session.agent.toolExecution = "parallel";
      session.agent.streamFunction = model => {
        modelRequests++;
        const stream = createAssistantMessageEventStream();
        streams.push(stream);
        const first = modelRequests === 1;
        const message: AssistantMessage = {
          role: "assistant",
          content: first ? [
            { type: "toolCall", id: "A", name: "fixture_A", arguments: {} },
            { type: "toolCall", id: "B", name: "fixture_B", arguments: {} },
          ] : [{ type: "text", text: "done" }],
          api: model.api, provider: model.provider, model: model.id,
          stopReason: first ? "toolUse" as const : "stop" as const, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: { ...message } });
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
        stream.end(message);
        return stream;
      };
      const completionSnapshots = new Map<string, string>();
      session.subscribe(event => {
        if (event.type === "tool_execution_end") {
          toolEnds.push(event.toolCallId);
          queueMicrotask(() => {
            const result = adapter?.getSessionSteps("s").steps.find(step => step.kind === "tool_result" && step.toolCallId === event.toolCallId);
            if (result) completionSnapshots.set(event.toolCallId, result.id);
          });
        }
      });
      adapter = new PiAgentAdapter(session as unknown as AgentSessionLike);
      running = adapter.prompt("offline parallel ordering");
      await expect.poll(() => entered.size).toBe(2);
      expect(completed.size).toBe(0);
      gateB.resolve();
      await expect.poll(() => toolEnds.length).toBe(1);
      expect(toolEnds).toEqual(["B"]);
      const beforeA = adapter.getSessionSteps("s");
      expect(beforeA.steps.filter(step => step.kind === "tool_result").map(step => step.toolCallId)).toEqual(["B"]);
      expect(beforeA.steps.find(step => step.kind === "tool_result")?.sourceEntryId).toBeUndefined();
      expect(sessionManager.getBranch().filter(entry => "message" in entry && entry.message.role === "toolResult")).toHaveLength(0);

      gateA.resolve();
      await running;
      expect(modelRequests).toBe(2);
      expect(toolEnds).toEqual(["B", "A"]);
      const resultEntries = sessionManager.getBranch().flatMap(entry =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry] : []);
      expect(resultEntries.map(entry => (entry.message as ToolResultMessage).toolCallId)).toEqual(["A", "B"]);
      const snapshot = adapter.getSessionSteps("s");
      const results = snapshot.steps.filter(step => step.kind === "tool_result");
      expect(results.map(step => step.toolCallId)).toEqual(["B", "A"]);
      expect(results.map(step => step.sourceEntryId)).toEqual([resultEntries[1]!.id, resultEntries[0]!.id]);
      expect(results).toHaveLength(2);
      expect(results.map(step => step.id)).toEqual([completionSnapshots.get("B"), completionSnapshots.get("A")]);
      // The final source binding is checked against the actual persisted branch entries above.
      expect(adapter.getSessionSteps("s")).toEqual(snapshot);
      const jsonlPath = sessionManager.getSessionFile()!;
      const jsonl = await readFile(jsonlPath, "utf8");
      const jsonlResultIds = jsonl.split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; message?: { role?: string; toolCallId?: string } })
        .filter(entry => entry.type === "message" && entry.message?.role === "toolResult").map(entry => entry.message!.toolCallId);
      expect(jsonlResultIds).toEqual(["A", "B"]);
      const cold = await readPiJsonlSteps(jsonlPath, "s");
      expect(cold.steps.filter(step => step.kind === "tool_result").map(step => step.toolCallId)).toEqual(["A", "B"]);
      expect(results.map(step => step.id)).toHaveLength(2);
      expect(adapter.getSessionSteps("s")).toEqual(snapshot);
    } finally {
      gateA.resolve();
      gateB.resolve();
      await session?.abort().catch(() => {});
      await running?.catch(() => {});
      adapter?.dispose();
      session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
