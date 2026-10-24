// The butler's tool isolation (docs/companion-butler.md §12.4) through the real composition root and
// SDK, offline: a PI_EXTENSION_PATHS extension registers a stub provider and its own tool, a plugin
// registers another, and the butler must still see only its butler_* tools — when it is new, after a
// restart restores it, and after a model switch. Ordinary sessions keep the extension and plugin tools.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdkSessions = vi.hoisted(() => [] as Array<{ getActiveToolNames(): string[]; setActiveToolsByName(names: string[]): void; systemPrompt: string }>);
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    createAgentSession: async (options: Parameters<typeof sdk.createAgentSession>[0]) => {
      const created = await sdk.createAgentSession(options);
      sdkSessions.push(created.session as unknown as (typeof sdkSessions)[number]);
      return created;
    },
  };
});

import { DatabaseSync } from "node:sqlite";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { BUTLER_TOOL_NAMES } from "../../src/butler/butler-tools.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";

const STUB_PROVIDER = "fixture-butler-provider";
const STUB_MODEL = "fixture-butler-model";
const STUB_REPLY = "butler-stub-reply";
const PROBE = "__piButlerProbe";

type Probe = { providerRequests: number };
const probe = () => ((globalThis as Record<string, unknown>)[PROBE] ??= { providerRequests: 0 }) as Probe;

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => {})));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  sdkSessions.splice(0);
  delete (globalThis as Record<string, unknown>)[PROBE];
});

function writeExtension(root: string): string {
  const dir = join(root, "extension");
  mkdirSync(join(dir, "extensions"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "butler-fixture", version: "1.0.0", type: "module", pi: { extensions: ["./extensions"] } }));
  writeFileSync(join(dir, "extensions", "index.ts"), `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const state = () => (globalThis[${JSON.stringify(PROBE)}] ??= { providerRequests: 0 });
const message = (model, text, stopReason) => ({
  role: "assistant", content: text === null ? [] : [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason, timestamp: 1,
});
export default function (pi) {
  pi.registerProvider(${JSON.stringify(STUB_PROVIDER)}, {
    name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "k", api: "fixture-butler-api",
    models: [{ id: ${JSON.stringify(STUB_MODEL)}, name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    async streamSimple(model, context, options) {
      await options?.onPayload?.({ messages: context.messages }, model);
      const stream = createAssistantMessageEventStream();
      const done = message(model, ${JSON.stringify(STUB_REPLY)}, "stop");
      stream.push({ type: "start", partial: message(model, null, "pending") });
      stream.push({ type: "done", reason: "stop", message: done });
      stream.end(done);
      return stream;
    },
  });
  pi.registerTool({ name: "fixture_extension_tool", label: "Fixture", description: "Offline fixture", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
  pi.on("before_provider_request", (event) => { state().providerRequests += 1; return event.payload; });
}
`);
  return dir;
}

function config(root: string, extension: string): StartConfig {
  return {
    port: 0,
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "127.0.0.1", role: "admin" }]) }),
    cwd: root, dataDir: root,
    nativeSessionSourceDir: join(root, "native"), authPath: join(root, "auth.json"), dbPath: join(root, "pi.db"),
    extensionPaths: [extension],
    defaultModel: { provider: STUB_PROVIDER, id: STUB_MODEL },
    plugins: [{
      manifest: { id: "fixture-tools", version: 1, tools: [{ name: "fixture_plugin_tool" }] },
      tools: [{ name: "fixture_plugin_tool", label: "Fixture", description: "Offline plugin fixture", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) } as unknown as ToolDefinition],
      register() {},
    }],
  };
}

async function start(root: string, extension: string): Promise<FastifyInstance> {
  const app = await startServer(config(root, extension));
  apps.push(app);
  return app;
}

async function turn(app: FastifyInstance, sessionId: string, requestId: string): Promise<void> {
  const sent = await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/messages`, payload: { requestId, prompt: "今天跑了什么" } });
  expect(sent.statusCode, sent.body).toBe(202);
  const deadline = Date.now() + 5000;
  for (;;) {
    const exported = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export` });
    const messages = (exported.json() as { messages?: Array<{ role: string; text: string }> }).messages ?? [];
    if (messages.filter(m => m.role === "assistant" && m.text === STUB_REPLY).length >= Number(requestId.slice(1))) return;
    if (Date.now() > deadline) throw new Error("turn did not finish");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

/** The tools active on the session just opened, and what is left after trying to widen them. */
function toolsOfLatest(): { active: string[]; widened: string[] } {
  const session = sdkSessions.at(-1)!;
  const active = session.getActiveToolNames();
  session.setActiveToolsByName(["read", "bash", "fixture_extension_tool", "fixture_plugin_tool", ...BUTLER_TOOL_NAMES]);
  return { active, widened: session.getActiveToolNames() };
}

describe("butler tool isolation → real SDK", () => {
  it("a butler only ever has its butler_* tools, new, restored and after a model switch", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-butler-isolation-")));
    dirs.push(root);
    const extension = writeExtension(root);
    const db = new DatabaseSync(join(root, "pi.db"));
    try { await runSqliteMigrations(db); } finally { db.close(); }
    const butlerTools = [...BUTLER_TOOL_NAMES].sort();

    const first = await start(root, extension);
    const created = await first.inject({ method: "POST", url: "/v1/butler", payload: {} });
    expect(created.statusCode, created.body).toBe(200);
    const butler = (created.json() as { session: { id: string } }).session;
    expect((await first.inject({ method: "POST", url: "/v1/butler", payload: {} })).json()).toMatchObject({ session: { id: butler.id } });

    const requestsBefore = probe().providerRequests;
    await turn(first, butler.id, "r1");
    const fresh = toolsOfLatest();
    expect(fresh.active.sort()).toEqual(butlerTools);
    expect(fresh.widened.sort()).toEqual(butlerTools);
    // The extension is not loaded for the butler, so its request hook does not run (§12.1 item 4).
    expect(probe().providerRequests).toBe(requestsBefore);
    expect(sdkSessions.at(-1)!.systemPrompt).toContain("管家");

    // Refused routes, and the butler stays out of the lists.
    expect((await first.inject({ method: "POST", url: `/v1/sessions/${butler.id}/commands`, payload: { command: "compact" } })).json()).toMatchObject({ code: "butler_restricted" });
    expect((await first.inject({ method: "PATCH", url: `/v1/sessions/${butler.id}`, payload: { title: "x" } })).statusCode).toBe(403);
    expect((await first.inject({ method: "DELETE", url: `/v1/sessions/${butler.id}` })).statusCode).toBe(403);
    expect((await first.inject({ method: "GET", url: "/v1/sessions" })).json()).toEqual([]);

    // An ordinary session keeps the extension and plugin tools.
    const chat = await first.inject({ method: "POST", url: "/v1/sessions", payload: { title: "chat" } });
    await turn(first, (chat.json() as { id: string }).id, "r1");
    expect(toolsOfLatest().active).toEqual(expect.arrayContaining(["fixture_extension_tool", "fixture_plugin_tool"]));

    // Restore after a restart, then switch the model.
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    const second = await start(root, extension);
    await turn(second, butler.id, "r2");
    const restored = toolsOfLatest();
    expect(restored.active.sort()).toEqual(butlerTools);
    expect(restored.widened.sort()).toEqual(butlerTools);
    const switched = await second.inject({ method: "PATCH", url: `/v1/sessions/${butler.id}/config`, payload: { modelProvider: STUB_PROVIDER, modelId: STUB_MODEL } });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(sdkSessions.at(-1)!.getActiveToolNames().sort()).toEqual(butlerTools);

    // A reset points at a new butler; the old one stays hidden.
    const reset = (await second.inject({ method: "POST", url: "/v1/butler", payload: { reset: true } })).json() as { session: { id: string } };
    expect(reset.session.id).not.toBe(butler.id);
    expect((await second.inject({ method: "GET", url: "/v1/butler" })).json()).toMatchObject({ session: { id: reset.session.id } });
    expect((await second.inject({ method: "GET", url: "/v1/sessions" })).json()).toHaveLength(1);
  });
});
