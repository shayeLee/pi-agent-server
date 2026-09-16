// Real SDK/offline integration for the externally installed model-failback engine.
// It deliberately loads the extension entry through a temporary, explicit loader path;
// no provider credentials or network transport are used. This is an independent integration
// check, not a pinned source checkout: run it with
// `PI_TEST_MODEL_FAILBACK_DIR=/path/to/model-failback pnpm exec vitest run tests/agent/model-failback-real.integration.test.ts`.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentSessionFactory } from "../../src/agent/pi-agent-session-factory.js";
import { PiAgentAdapter } from "../../src/agent/pi-agent-adapter.js";
import { getProviderExtensionEventBus, loadSessionResourceLoader } from "../../src/server/provider-extensions.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { AgentSessionContext } from "../../src/application/ports/conversation-port.js";

const ENGINE_EXTENSION = process.env.PI_TEST_MODEL_FAILBACK_DIR?.trim()
  || join(homedir(), ".pi", "agent", "extensions", "model-failback");
const ENGINE_MODULE_PATH = join(ENGINE_EXTENSION, "core", "engine.ts");
const ENGINE_MODULE = pathToFileURL(ENGINE_MODULE_PATH).href;
const FAUX_MODULE = pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href;
const REAL_ENGINE_AVAILABLE = existsSync(ENGINE_MODULE_PATH);
const TEST_HOOKS_KEY = "__piModelFailbackTestHooks";
type RealTestHooks = {
  readonly markEntered: () => void;
  readonly gate: Promise<void>;
  fallbackCalls: number;
};
const cleanups: string[] = [];

if (!REAL_ENGINE_AVAILABLE) {
  console.info(
    `[model-failback real integration] skipped: external extension is not installed at ${ENGINE_EXTENSION}. ` +
    "Set PI_TEST_MODEL_FAILBACK_DIR and run the standalone command in this file's header.",
  );
}

function setTestHooks(hooks: RealTestHooks): void {
  (globalThis as typeof globalThis & { [TEST_HOOKS_KEY]?: RealTestHooks })[TEST_HOOKS_KEY] = hooks;
}

function clearTestHooks(): void {
  delete (globalThis as typeof globalThis & { [TEST_HOOKS_KEY]?: RealTestHooks })[TEST_HOOKS_KEY];
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-model-failback-real-"));
  cleanups.push(root);
  return root;
}

afterEach(() => {
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeOfflineProviders(root: string): string {
  const extension = join(root, "offline-providers");
  mkdirSync(join(extension, "extensions"), { recursive: true });
  writeFileSync(join(extension, "package.json"), JSON.stringify({
    name: "offline-model-failback-providers",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./extensions"] },
  }));
  writeFileSync(join(extension, "extensions", "providers.ts"), `
import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(FAUX_MODULE)};
const exhausted = createFauxCore({ provider: "modelscope", models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "offline exhausted", reasoning: true, contextWindow: 4096, maxTokens: 128 }] });
const fallback = createFauxCore({ provider: "workbuddy", models: [{ id: "deepseek-v4.1-flash", name: "offline fallback", reasoning: true, contextWindow: 4096, maxTokens: 128 }] });
const fallbackStream = fallback.streamSimple;
exhausted.setResponses([
  fauxAssistantMessage("", { stopReason: "error", errorMessage: '429: {"message":"insufficient balance"}' }),
  fauxAssistantMessage("", { stopReason: "error", errorMessage: '429: {"message":"insufficient balance"}' }),
]);
fallback.setResponses([
  fauxAssistantMessage("offline fallback completed", { stopReason: "stop" }),
  fauxAssistantMessage("offline fallback completed next prompt", { stopReason: "stop" }),
]);
export default function (pi) {
  pi.registerProvider("modelscope", { api: exhausted.api, baseUrl: "http://127.0.0.1:1", apiKey: "offline", models: exhausted.models, streamSimple: exhausted.streamSimple });
  pi.registerProvider("workbuddy", {
    api: fallback.api, baseUrl: "http://127.0.0.1:1", apiKey: "offline", models: fallback.models,
    streamSimple: (...args) => {
      const hooks = globalThis.__piModelFailbackTestHooks;
      if (hooks) hooks.fallbackCalls++;
      return fallbackStream(...args);
    },
  });
}
`);
  return extension;
}

function writeGatedEngine(root: string): string {
  const extension = join(root, "gated-engine");
  mkdirSync(join(extension, "extensions"), { recursive: true });
  writeFileSync(join(extension, "package.json"), JSON.stringify({
    name: "offline-model-failback-gated-engine", version: "1.0.0", type: "module", pi: { extensions: ["./extensions"] },
  }));
  writeFileSync(join(extension, "extensions", "engine.ts"), `
import { createEngine } from ${JSON.stringify(ENGINE_MODULE)};
const bans = new Map();
const hooks = globalThis.__piModelFailbackTestHooks;
if (!hooks) throw new Error("model-failback test hooks were not installed");
const store = {
  refresh: async () => {}, setSessionId: () => {}, endSession: async () => {},
  isBlocked: (key) => bans.has(key), get: (key) => bans.get(key),
  list: () => [...bans].map(([key, record]) => ({ key, record })), clear: async (key) => { if (key) bans.delete(key); else bans.clear(); },
  mark: async (key, record) => { hooks.markEntered(); await hooks.gate; bans.set(key, record); return key; },
};
export default function (pi) { createEngine(pi, () => ({ fallbacks: { "modelscope/deepseek-ai/DeepSeek-V4.1-Flash": "workbuddy/deepseek-v4.1-flash" } }), store); }
`);
  return extension;
}

function context(root: string): AgentSessionContext {
  return {
    sessionId: "offline-failback",
    projectId: DEFAULT_PROJECT_ID,
    projectCwd: root,
    dataDir: join(root, "data"),
    modelProvider: "modelscope",
    modelId: "deepseek-ai/DeepSeek-V4.1-Flash",
    thinkingLevel: "high",
    isNewSession: true,
    agentToolConfig: { noTools: "all" },
  };
}

describe.skipIf(!REAL_ENGINE_AVAILABLE).sequential("real model-failback extension through PiAgentSessionFactory", () => {
  it("keeps one failback chain across Pi auto-retry agent.continue runs without network", async () => {
    const root = tempRoot();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSessionDir = process.env.PI_SESSION_DIR;
    const previousFailbackChild = process.env.MODEL_FAILBACK_CHILD;
    const previousFailbackSessionId = process.env.MODEL_FAILBACK_SESSION_ID;
    const previousPiSessionId = process.env.PI_SESSION_ID;
    const originalFetch = globalThis.fetch;
    // This is a root SDK session, not an inherited agent-team worker identity.
    delete process.env.MODEL_FAILBACK_CHILD;
    delete process.env.MODEL_FAILBACK_SESSION_ID;
    delete process.env.PI_SESSION_ID;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SESSION_DIR = join(root, "sessions");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-failback.json"), JSON.stringify({
      fallbacks: {
        "modelscope/deepseek-ai/DeepSeek-V4.1-Flash": "workbuddy/deepseek-v4.1-flash",
      },
    }));
    globalThis.fetch = (async () => { throw new Error("network is forbidden in offline failback integration"); }) as typeof fetch;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: join(root, "models.json"),
        refreshOnCreate: false,
      });
      const offlineProviders = writeOfflineProviders(root);
      // The factory resolves its selected model before it creates the session-local
      // loader, exactly as production startup does after its provider bootstrap.
      await loadSessionResourceLoader(runtime, {
        extensionCwd: root,
        agentDir: process.env.PI_CODING_AGENT_DIR!,
        providerExtensionPaths: [offlineProviders, ENGINE_EXTENSION],
        systemPrompt: "offline failback integration",
      });
      const factory = new PiAgentSessionFactory({
        modelRuntime: runtime,
        defaultModel: runtime.getModel("modelscope", "deepseek-ai/DeepSeek-V4.1-Flash"),
        agentToolConfig: { noTools: "all" },
        createResourceLoader: async ({ projectCwd }) => {
          const loader = await loadSessionResourceLoader(runtime, {
            extensionCwd: root,
            agentDir: process.env.PI_CODING_AGENT_DIR!,
            providerExtensionPaths: [offlineProviders, ENGINE_EXTENSION],
            systemPrompt: "offline failback integration",
          });
          return { loader, failbackLifecycleSource: getProviderExtensionEventBus(loader) };
        },
      });
      const prepared = await factory.prepareNew(context(root));
      const opened = await prepared.open();
      const adapter = opened.adapter as PiAgentAdapter;
      const lifecycle: unknown[] = [];
      const unsubscribe = adapter.subscribeFailbackLifecycle((event) => lifecycle.push(event));
      try {
        await adapter.prompt("run the offline failback fixture");
        expect(adapter.getConfigurationSnapshot()).toMatchObject({
          modelProvider: "workbuddy",
          modelId: "deepseek-v4.1-flash",
        });
        expect((await adapter.exportSession() as { messages: unknown[] }).messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "assistant", text: "offline fallback completed" }),
        ]));
        expect(lifecycle).toEqual(expect.arrayContaining([
          expect.objectContaining({ phase: "start" }),
          expect.objectContaining({ phase: "end", outcome: "switched" }),
        ]));
        // The faux source returns two retryable 429 terminal messages. Pi emits a new
        // agent_start for agent.continue(), but it must not be treated as a new user task.
        expect(lifecycle.filter((event) => (event as { phase?: string; outcome?: string }).phase === "end" && (event as { outcome?: string }).outcome === "switched")).toHaveLength(1);
        // This is a real new SDK prompt after the steer/continue sequence, not a
        // synthesized lifecycle event. It must be accepted independently.
        await adapter.prompt("run the next real offline request");
        expect((await adapter.exportSession() as { messages: unknown[] }).messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "assistant", text: "offline fallback completed next prompt" }),
        ]));
        expect(lifecycle.filter((event) => (event as { phase?: string; outcome?: string }).phase === "end" && (event as { outcome?: string }).outcome === "switched")).toHaveLength(1);
        // The real JSONL records pi.setModel. Restore must prefer that projection
        // over the stale source-model value supplied by the host/DB context. Derive this
        // fixture's ban name from the SDK's real session header, never a host-supplied ID.
        const conversationRef = opened.conversation.conversationRef;
        adapter.dispose();
        expect(conversationRef).toBeTruthy();
        expect(existsSync(conversationRef!)).toBe(true);
        const header = JSON.parse(readFileSync(conversationRef!, "utf8").split("\n", 1)[0]!) as { id?: unknown };
        expect(typeof header.id).toBe("string");
        const banFile = join(process.env.PI_CODING_AGENT_DIR!, `model-failback-bans-${header.id}.json`);
        expect(existsSync(banFile)).toBe(true);
        rmSync(banFile);
        expect(existsSync(banFile)).toBe(false);
        const beforeRestore = readFileSync(conversationRef!, "utf8");
        const restored = await factory.restore({ ...context(root), isNewSession: false }, opened.conversation);
        try {
          expect((restored as PiAgentAdapter).getConfigurationSnapshot()).toMatchObject({
            modelProvider: "workbuddy", modelId: "deepseek-v4.1-flash", thinkingLevel: "high",
          });
          // No retained ban means restore must not take engine session_start preflight.
          expect(readFileSync(conversationRef!, "utf8")).toBe(beforeRestore);
        } finally {
          restored.dispose();
        }
      } finally {
        unsubscribe();
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = previousSessionDir;
      if (previousFailbackChild === undefined) delete process.env.MODEL_FAILBACK_CHILD;
      else process.env.MODEL_FAILBACK_CHILD = previousFailbackChild;
      if (previousFailbackSessionId === undefined) delete process.env.MODEL_FAILBACK_SESSION_ID;
      else process.env.MODEL_FAILBACK_SESSION_ID = previousFailbackSessionId;
      if (previousPiSessionId === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = previousPiSessionId;
    }
  });

  it("cancels during the real engine's async ban gate, then accepts a new fallback request", async () => {
    const root = tempRoot();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSessionDir = process.env.PI_SESSION_DIR;
    const originalFetch = globalThis.fetch;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SESSION_DIR = join(root, "sessions");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    let markEnteredResolve!: () => void;
    let releaseGate!: () => void;
    const markEntered = new Promise<void>((resolve) => { markEnteredResolve = resolve; });
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const hooks: RealTestHooks = { markEntered: markEnteredResolve, gate, fallbackCalls: 0 };
    setTestHooks(hooks);
    globalThis.fetch = (async () => { throw new Error("network is forbidden in offline failback integration"); }) as typeof fetch;
    try {
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
      const offlineProviders = writeOfflineProviders(root);
      const gatedEngine = writeGatedEngine(root);
      await loadSessionResourceLoader(runtime, {
        extensionCwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!,
        providerExtensionPaths: [offlineProviders, gatedEngine], systemPrompt: "offline failback integration",
      });
      const factory = new PiAgentSessionFactory({
        modelRuntime: runtime,
        defaultModel: runtime.getModel("modelscope", "deepseek-ai/DeepSeek-V4.1-Flash"),
        agentToolConfig: { noTools: "all" },
        createResourceLoader: async () => {
          const loader = await loadSessionResourceLoader(runtime, {
            extensionCwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!,
            providerExtensionPaths: [offlineProviders, gatedEngine], systemPrompt: "offline failback integration",
          });
          return { loader, failbackLifecycleSource: getProviderExtensionEventBus(loader) };
        },
      });
      const opened = await (await factory.prepareNew(context(root))).open();
      const adapter = opened.adapter as PiAgentAdapter;
      let started!: () => void;
      const startSeen = new Promise<void>((resolve) => { started = resolve; });
      const unsubscribe = adapter.subscribeFailbackLifecycle((event) => { if (event.phase === "start") started(); });
      try {
        const cancelledRun = adapter.prompt("first request is cancelled in async gate");
        await startSeen;
        // lifecycle start precedes bans.mark; wait for the real engine to enter mark before aborting.
        await markEntered;
        const aborting = adapter.abort();
        // Let the real engine leave mark and observe the cancellation boundary.
        releaseGate();
        await aborting;
        await cancelledRun;
        expect(hooks.fallbackCalls).toBe(0);
        expect(adapter.getConfigurationSnapshot()).toMatchObject({ modelProvider: "modelscope" });

        await adapter.prompt("new request must not inherit the cancelled gate");
        expect(hooks.fallbackCalls).toBe(1);
        expect(adapter.getConfigurationSnapshot()).toMatchObject({
          modelProvider: "workbuddy", modelId: "deepseek-v4.1-flash",
        });
      } finally {
        unsubscribe();
        opened.adapter.dispose();
      }
    } finally {
      globalThis.fetch = originalFetch;
      clearTestHooks();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = previousSessionDir;
    }
  });
});
