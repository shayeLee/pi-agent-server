import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ModelRuntime, ResourceLoader } from "@earendil-works/pi-coding-agent";

const createSdk = vi.hoisted(() => vi.fn());
const openFds = vi.hoisted(() => new Set<number>());
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); openFds.add(fd); return fd; },
    closeSync: (fd: number) => { openFds.delete(fd); return fs.closeSync(fd); } };
});
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(), createAgentSession: createSdk,
}));
import { PiAgentSessionFactory } from "../../src/agent/pi-agent-session-factory.js";
import { NativeSessionSource, nativeProjectDirectory } from "../../src/agent/native-session-source.js";
import { NativeSessionPolicy, canonicalCwdIdentity } from "../../src/core/native-session-policy.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";

const roots: string[] = [];
afterEach(() => { expect(openFds.size).toBe(0); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

async function guardedFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-guard-"))); roots.push(root);
  const cwd = path.join(root, "cwd"); mkdirSync(cwd);
  const exclusion = path.join(root, "exclude"); mkdirSync(exclusion);
  const nativeRoot = path.join(root, "sources"); const dir = path.join(nativeRoot, nativeProjectDirectory(cwd)); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "original.jsonl"); writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "original", cwd }) + "\n");
  const external = path.join(root, "external.jsonl"); writeFileSync(external, "external unchanged\n");
  const source = new NativeSessionSource(nativeRoot, new NativeSessionPolicy([exclusion]));
  const binding = (await source.scan(canonicalCwdIdentity(cwd))).sources[0]!.binding;
  const factory = new PiAgentSessionFactory({ modelRuntime: {} as ModelRuntime, defaultModel: { provider: "fixture", id: "offline" } as never, native: { source, index: { binding: async () => binding, claim: async () => null } }, agentToolConfig: {},
    createResourceLoader: async () => ({ loader: {} as ResourceLoader, failbackLifecycleSource: { on: () => () => {} } }) });
  const context = { sessionId: "server", projectId: DEFAULT_PROJECT_ID, projectCwd: cwd, dataDir: root, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, isNewSession: false, agentToolConfig: {} };
  return { root, cwd, file, external, exclusion, factory, context, descriptor: { agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: file } };
}

describe("native factory with fake SDK, original persistent manager", () => {
  it("creates Web-private native-layout JSONL only after a claim, even in a share-excluded cwd", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "unified-private-"))); roots.push(root);
    const cwd = path.join(root, "cwd"); mkdirSync(cwd);
    const source = new NativeSessionSource(path.join(root, "sessions"), new NativeSessionPolicy([cwd]));
    let saved: any;
    const reservePrivate = vi.fn(async (_project, binding) => {
      expect(() => readFileSync(binding.sourcePath)).toThrow();
      saved = binding;
    });
    const finalizePrivate = vi.fn(async binding => { saved = binding; });
    const retirePrivate = vi.fn(async () => {});
    const factory = new PiAgentSessionFactory({ modelRuntime: {} as ModelRuntime, defaultModel: { provider: "fixture", id: "offline" } as never,
      unified: { source, index: { binding: async () => saved, claim: async () => null, reservePrivate, finalizePrivate, retirePrivate } }, agentToolConfig: {},
      createResourceLoader: async () => ({ loader: {} as ResourceLoader, failbackLifecycleSource: { on: () => () => {} } }) });
    createSdk.mockImplementation(async options => ({ session: { messages: [], sessionFile: options.sessionManager.getSessionFile(),
      subscribe: () => () => {}, dispose() {}, prompt: async () => options.sessionManager.appendMessage({ role: "user", content: "private", timestamp: 1 }) } }));
    const context = { sessionId: "web-id", projectId: DEFAULT_PROJECT_ID, projectCwd: cwd, dataDir: root,
      modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, isNewSession: true, agentToolConfig: {} };
    const prepared = await factory.prepareNew(context);
    expect(reservePrivate).not.toHaveBeenCalled();
    const opened = await prepared.open();
    expect(path.dirname(opened.conversation.conversationRef!)).toBe(path.join(source.root, nativeProjectDirectory(cwd)));
    expect(saved.private).toBe(true); expect(saved.sourceId).not.toBe(context.sessionId);
    expect(JSON.parse(readFileSync(saved.sourcePath, "utf8").split("\n")[0]!).id).toBe(saved.sourceId);
    await opened.adapter.prompt("private"); opened.adapter.dispose();
    expect((await source.scan(canonicalCwdIdentity(cwd))).sources).toEqual([]);
    const restored = await factory.restore(context, opened.conversation);
    await restored.prompt("continued"); restored.dispose();
    expect(retirePrivate).not.toHaveBeenCalled();
  });
  it("passes original ID/file and trusted cwd, appends in place and rejects arbitrary references/v2/exclusion", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-factory-"))); roots.push(root);
    const cwd = path.join(root, "cwd"); mkdirSync(cwd);
    const nativeRoot = path.join(root, "sources"); const dir = path.join(nativeRoot, nativeProjectDirectory(cwd)); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "original.jsonl"); const header = JSON.stringify({ type: "session", version: 3, id: "native-original-id", cwd }) + "\n";
    writeFileSync(file, header);
    const source = new NativeSessionSource(nativeRoot, new NativeSessionPolicy([]));
    const binding = (await source.scan(canonicalCwdIdentity(cwd))).sources[0]!.binding;
    const index = { binding: async () => binding, claim: async () => null };
    const factory = new PiAgentSessionFactory({ modelRuntime: {} as ModelRuntime, defaultModel: { provider: "fixture", id: "offline" } as never, native: { source, index }, agentToolConfig: {},
      createResourceLoader: async () => ({ loader: {} as ResourceLoader, failbackLifecycleSource: { on: () => () => {} } }) });
    createSdk.mockImplementation(async options => {
      expect(options.sessionManager.getSessionId()).toBe("native-original-id");
      expect(options.sessionManager.getSessionFile()).toBe(file); expect(options.cwd).toBe(cwd);
      return { session: { messages: [], sessionFile: file, subscribe: () => () => {},
        prompt: async (text: string) => options.sessionManager.appendMessage({ role: "user", content: text, timestamp: 1 }), dispose() {} } };
    });
    const context = { sessionId: "server-id-not-native-id", projectId: DEFAULT_PROJECT_ID, projectCwd: cwd, dataDir: path.join(root, "managed"),
      modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, isNewSession: false, agentToolConfig: {} };
    const descriptor = { agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: file };
    const adapter = await factory.restore(context, descriptor);
    expect(readFileSync(file, "utf8")).toBe(header); await adapter.prompt("continued");
    expect(readFileSync(file, "utf8").startsWith(header)).toBe(true); expect(readFileSync(file, "utf8")).toContain("continued");
    await expect(factory.restore(context, { ...descriptor, conversationRef: path.join(root, "outside.jsonl") })).rejects.toThrow("unavailable");
    const legacy = header.replace('"version":3', '"version":2'); writeFileSync(file, legacy);
    await expect(factory.restore(context, descriptor)).rejects.toThrow("unavailable"); expect(readFileSync(file, "utf8")).toBe(legacy);
    expect(createSdk).toHaveBeenCalledTimes(1); adapter.dispose();
  });

  it("fake SDK pauses inside prompt; swapped path cannot redirect append, output or export", async () => {
    const f = await guardedFixture(); let resume!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); const paused = new Promise<void>(resolve => { resume = resolve; });
    const listeners = new Set<(event: any) => void>(); const abort = vi.fn(async () => {}); const dispose = vi.fn();
    createSdk.mockImplementation(async options => ({ session: { messages: [], sessionFile: f.file, abort, dispose,
      subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      bindExtensions: async () => options.sessionManager.appendCustomEntry("extension-start", {}),
      prompt: async () => {
        entered(); await paused;
        try { options.sessionManager.appendMessage({ role: "user", content: "forbidden", timestamp: 1 }); }
        finally { for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "must-not-leak" } }); }
      },
    } }));
    const adapter = await f.factory.restore(f.context, f.descriptor); const output = vi.fn(); adapter.subscribe(output);
    expect(readFileSync(f.file, "utf8")).toContain("extension-start");
    const run = adapter.prompt("continue"); await waiting;
    renameSync(f.file, f.file + ".old"); symlinkSync(f.external, f.file); resume();
    await expect(run).rejects.toThrow("invalidated"); expect(output).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalled(); expect(dispose).toHaveBeenCalled();
    await expect(adapter.prompt("retry")).rejects.toThrow();
    await expect(adapter.exportSession()).rejects.toThrow();
    expect(readFileSync(f.external, "utf8")).toBe("external unchanged\n"); adapter.dispose();
  });

  it.each(["create", "bind"])("closes descriptor on %s startup failure", async stage => {
    const f = await guardedFixture(); const dispose = vi.fn();
    createSdk.mockImplementation(async options => {
      options.sessionManager.appendCustomEntry("extension-start", {});
      if (stage === "create") throw new Error("startup failed");
      return { session: { messages: [], subscribe: () => () => {}, dispose, bindExtensions: async () => { throw new Error("bind failed"); } } };
    });
    await expect(f.factory.restore(f.context, f.descriptor)).rejects.toThrow("failed");
    if (stage === "bind") expect(dispose).toHaveBeenCalled();
    expect(readFileSync(f.file, "utf8")).toContain("extension-start"); expect(openFds.size).toBe(0);
  });

  it("revokes before SDK emits a delta and refuses subsequent persistence", async () => {
    const f = await guardedFixture(); let sdk: any;
    createSdk.mockImplementation(async options => {
      const listeners = new Set<(event: any) => void>();
      sdk = { messages: [], abort: vi.fn(async () => {}), dispose: vi.fn(),
        subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        _emit: (event: any) => { for (const listener of listeners) listener(event); },
        prompt: async () => options.sessionManager.appendCustomEntry("retry", {}),
      }; return { session: sdk };
    });
    const adapter = await f.factory.restore(f.context, f.descriptor); const output = vi.fn(); adapter.subscribe(output);
    rmSync(f.exclusion, { recursive: true });
    sdk._emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "secret" } });
    expect(output).not.toHaveBeenCalled(); expect(sdk.abort).toHaveBeenCalled(); expect(sdk.dispose).toHaveBeenCalled();
    await expect(adapter.prompt("retry")).rejects.toThrow(); adapter.dispose();
  });
});
