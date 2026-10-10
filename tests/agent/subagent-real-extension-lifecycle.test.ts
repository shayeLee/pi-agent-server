// Opt-in: exercise an installed extension COPY with real SDK and OS child processes.
// The child executable is deterministic; no model, credential, or user session is used.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { buildApp } from "../../src/server/app.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";
import { identityKey } from "../../src/core/user-identity.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";

const entry = process.env.PI_AGENT_TEAM_EXTENSION_UNDER_TEST;
describe.skipIf(!entry)("real agent-team process lifecycle (explicit opt-in)", () => {
  it.each(["http", "terminal"] as const)("%s abort retains child and handles; explicit stop terminates", async mode => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-team-real-lifecycle-")));
    const extensionDir = join(root, "extension");
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    const binDir = join(root, "bin");
    const logPath = join(root, "child.jsonl");
    mkdirSync(agentDir); mkdirSync(binDir); mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
    cpSync(dirname(entry!), extensionDir, { recursive: true, filter: source => !source.includes("/.git") });
    if (process.env.PI_AGENT_TEAM_BASELINE_INDEX) copyFileSync(process.env.PI_AGENT_TEAM_BASELINE_INDEX, join(extensionDir, "index.ts"));
    copyFileSync(join(extensionDir, "harness", "fake-pi.cjs"), join(binDir, "pi"));
    chmodSync(join(binDir, "pi"), 0o755);
    writeFileSync(join(projectDir, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Offline process fixture\nmodel: openai/gpt-4o\ntools: read\n---\nFixture only.\n");
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH}`);
    vi.stubEnv("FAKE_PI_LOG", logPath);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", root);
    vi.stubGlobal("fetch", async () => { throw new Error("offline lifecycle test forbids provider/network access"); });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const bus = createEventBus();
    bus.on("agent-team:host-identity", (value: any) => value.accept({ version: 1, host: "pi-agent-server" }));
    bus.on("agent-team:host-transport", (value: any) => value.accept({ post: async () => ({ accepted: false, reason: "fixture-no-followup" }) }));
    const lifecycle: string[] = [];
    const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager: settings, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(extensionDir, "index.ts")],
      extensionFactories: [pi => { pi.on("session_shutdown", event => { lifecycle.push(event.reason); }); }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
    await models.setRuntimeApiKey("openai", "offline-fixture-key");
    const manager = SessionManager.inMemory(projectDir);
    const { session } = await createAgentSession({ cwd: projectDir, agentDir, resourceLoader: loader, modelRuntime: models,
      model: getModel("openai", "gpt-4o")!, settingsManager: settings, sessionManager: manager,
      tools: ["subagent", "subagent_wait", "subagent_status", "subagent_logs", "subagent_stop"] });
    let action: { name: string; arguments: Record<string, unknown> } | undefined;
    let callNo = 0;
    let waiting = false;
    const results: any[] = [];
    session.agent.streamFunction = model => {
      const next = action; action = undefined;
      const stream = createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: next ? [{ type: "toolCall", id: `t${++callNo}`, ...next }] : [{ type: "text", text: "fixture done" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: next ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: next ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    session.subscribe(event => {
      if (event.type === "tool_execution_start" && event.toolName === "subagent_wait") waiting = true;
      if (event.type === "tool_execution_end") results.push(event.result);
    });
    const adapter = new PiAgentAdapter(session as unknown as AgentSessionLike);
    await session.bindExtensions({ mode: "json", onError: error => { throw error; } });
    const db = await makeInitializedMemoryDb({ dataDir: root });
    await db.sessions.create({ id: "lifecycle", title: "fixture", ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }), projectId: DEFAULT_PROJECT_ID,
      createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null,
      modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
    const app = buildApp({ sessions: db.sessions, projects: db.projects, defaultProjectCwd: projectDir,
      ipAccess: makeTestIpAccess(), createAdapter: async () => adapter });
    const invoke = async (name: string, args: Record<string, unknown>) => {
      results.length = 0; action = { name, arguments: args };
      await adapter.prompt(`fixture ${name}`);
      expect(results.length).toBe(1);
      return results[0];
    };
    const childRows = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const runningIds: string[] = [];
    try {
      const launched = await invoke("subagent", { agent: "worker", agentScope: "project", task: "SCENARIO:long_running" });
      const id = launched.details.liveRunIds[0]; runningIds.push(id);
      await vi.waitFor(() => expect(childRows().some(row => row.task?.includes("long_running"))).toBe(true));
      action = { name: "subagent_wait", arguments: { runIds: [id], timeoutMs: 30000 } };
      let terminalWait: Promise<void> | undefined;
      if (mode === "http") {
        const accepted = await app.inject({ method: "POST", url: "/v1/sessions/lifecycle/messages", payload: { prompt: "wait", requestId: "parent-wait" } });
        expect(accepted.statusCode, accepted.body).toBe(202);
      } else terminalWait = session.prompt("wait");
      await vi.waitFor(() => expect(waiting).toBe(true));
      if (mode === "http") {
        const aborted = await app.inject({ method: "POST", url: "/v1/sessions/lifecycle/abort", payload: { requestId: "parent-wait" } });
        expect(aborted.statusCode).toBe(204);
      } else { await session.abort(); await terminalWait; }
      await vi.waitFor(() => expect(session.isIdle).toBe(true));
      expect(lifecycle).toEqual([]); // Neither Web nor terminal abort closes/reloads the session.
      const beforeReload = await invoke("subagent_status", { runId: id });
      expect(beforeReload.content[0].text).toContain("status: running");
      expect(childRows().some(row => row.signal === "SIGTERM")).toBe(false);
      const logs = await invoke("subagent_logs", { runId: id });
      expect(logs.content[0].text).not.toContain("No background run");
      expect(lifecycle).toEqual([]);
      expect(childRows().some(row => row.signal === "SIGTERM")).toBe(false);
      const second = await invoke("subagent", { agent: "worker", agentScope: "project", task: "SCENARIO:long_running second" });
      const secondId = second.details.liveRunIds[0]; runningIds.push(secondId);
      expect(secondId).not.toBe(id);
      await invoke("subagent_stop", { runId: id });
      const stopped = await invoke("subagent_wait", { runIds: [id], timeoutMs: 10000 });
      expect(stopped.details.results[0].stopReason).toBe("stopped");
      const other = await invoke("subagent_status", { runId: secondId });
      expect(other.content[0].text).toContain("status: running");
      await invoke("subagent_stop", { runId: secondId });
      await invoke("subagent_wait", { runIds: [secondId], timeoutMs: 10000 });
      expect(childRows().some(row => row.signal === "SIGTERM")).toBe(true);
      // A real quit is different from reload and must still clean up owned children.
      const onQuit = await invoke("subagent", { agent: "worker", agentScope: "project", task: "SCENARIO:long_running quit-only" });
      runningIds.push(onQuit.details.liveRunIds[0]);
      await vi.waitFor(() => expect(childRows().some(row => row.task?.includes("quit-only"))).toBe(true));
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await vi.waitFor(() => expect(childRows().some(row => row.task?.includes("quit-only") && row.signal === "SIGTERM")).toBe(true));
    } finally {
      await session.abort();
      for (const runId of runningIds) { try { await invoke("subagent_stop", { runId }); await invoke("subagent_wait", { runIds: [runId], timeoutMs: 1000 }); } catch { /* cleanup only */ } }
      await app.close(); await db.close(); session.dispose();
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
