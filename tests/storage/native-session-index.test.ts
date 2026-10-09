import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { KyselyNativeSessionIndex } from "../../src/storage/kysely-native-session-index.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { sqliteConstraintErrorMapper } from "../../src/storage/sqlite-constraint-errors.js";
import { NativeSessionPolicy, canonicalCwdIdentity } from "../../src/core/native-session-policy.js";
import { NativeSessionSource, nativeProjectDirectory } from "../../src/agent/native-session-source.js";
import { NativeSessionService } from "../../src/application/native-session-service.js";
import { NativePiConversationStorage } from "../../src/agent/native-pi-conversation-storage.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { SessionService } from "../../src/application/session-service.js";
import { RuntimeRegistry } from "../../src/runtime/runtime-registry.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { openNativeSessionManager } from "../../src/agent/native-session-fd.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { migrationDefinitions, migrationChecksum } from "../../src/storage/migration-manifest.js";
import { MIGRATION_V1_GOLDEN_CHECKSUM } from "../../src/storage/migration-manifest.js";
import { steeringSdkFixture } from "../agent/steering-sdk-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-index-"))); cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"); mkdirSync(cwd);
  const sessionsRoot = path.join(root, "native"); mkdirSync(path.join(sessionsRoot, nativeProjectDirectory(cwd)), { recursive: true });
  const file = path.join(sessionsRoot, nativeProjectDirectory(cwd), "original.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "original", cwd, timestamp: new Date(0).toISOString() }) + "\n");
  const db = new DatabaseSync(path.join(root, "fixture.db")); const kysely = await initializeDatabase(db); cleanup.push(() => kysely.destroy());
  const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper, { cleanupPlan: () => null, enforceCanonicalCwd: true, defaultProjectCwd: cwd });
  await projects.ensureDefaultProject({ id: DEFAULT_PROJECT_ID, name: "Default", cwd, ownerKey: "", createdAt: 0 });
  const sessions = new KyselySessionRepository(kysely, sqliteConstraintErrorMapper, { cleanupPlan: () => null });
  const index = new KyselyNativeSessionIndex(kysely, "sqlite", { defaultProjectCwd: cwd });
  const source = new NativeSessionSource(sessionsRoot, new NativeSessionPolicy([]));
  const native = new NativeSessionService(source, index, randomUUID);
  const storage = new ConversationStorageRegistry(); storage.register(new NativePiConversationStorage(source, index));
  return { root, cwd, file, db, kysely, projects, sessions, index, source, native, storage };
}

describe("native durable shared index", () => {
  it("shared actors cannot replay another actor's control or fabricate consumption acknowledgement", async () => {
    const f = await fixture();
    await f.native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd });
    const id = (await f.sessions.listByOwner("any"))[0]!.id;
    const sdk = await steeringSdkFixture(f.root);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline fixture"));
    const registry = new RuntimeRegistry({ concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 1, perUserQueueLimit: 1, queueTimeoutMs: 1000 }), createAdapter: async () => sdk.adapter });
    const service = new SessionService({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native, registry, createId: randomUUID, now: Date.now });
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native, registry,
      ipAccess: makeTestIpAccess(), createAdapter: async () => sdk.adapter });
    const post = (actor: string, suffix: string, payload: unknown) => app.inject({ method: "POST", url: `/v1/sessions/${id}/${suffix}`, remoteAddress: actor, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
    try {
      const live = (await service.getEntry("ip:10.0.0.1", id))!;
      const events: import("../../src/runtime/session-event-bus.js").SseEventBatch[] = []; live.events.subscribe(row => events.push(row));
      expect((await post("10.0.0.1", "messages", { requestId: "primary", prompt: "same" })).statusCode).toBe(202);
      await vi.waitFor(() => expect(sdk.waits()).toBe(1));
      const control = { text: "same", requestId: "primary", controlId: "one", acknowledgementId: "actor-one-token" };
      expect((await post("10.0.0.1", "steer", control)).statusCode).toBe(202);
      expect((await post("10.0.0.2", "steer", control)).statusCode).toBe(409);
      expect((await post("10.0.0.2", "steer", { ...control, acknowledgementId: "forged" })).statusCode).toBe(409);
      expect(events.filter(row => row.event.type === "steering_consumed")).toHaveLength(0);
      sdk.release(); await vi.waitFor(() => expect(sdk.waits()).toBe(2));
      // SessionEventBus envelopes carry the original, nonterminal payload.
      const acknowledgements = events.map(row => row.event).filter(row => row.type === "steering_consumed");
      const consumedEntry = sdk.session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
      expect(acknowledgements).toEqual([{ type: "steering_consumed", controlId: "one", acknowledgementId: "actor-one-token", requestId: "primary",
        message: { sourceId: consumedEntry.id, text: "same" } }]);
      expect(live.runtime.state).toBe("streaming");
      expect(sdk.session.messages.filter(message => message.role === "user")).toHaveLength(2);
    } finally { await sdk.adapter.abort(); await app.close(); registry.dispose(); network.mockRestore(); }
  });
  it("creates actor-private sessions in visible shared projects without granting project or cross-owner access", async () => {
    const f = await fixture();
    const sharedCwd = path.join(f.root, "shared"); mkdirSync(sharedCwd);
    const directory = path.join(f.source.root, nativeProjectDirectory(sharedCwd));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "shared.jsonl"), JSON.stringify({ type: "session", version: 3, id: "shared", cwd: sharedCwd, timestamp: new Date(0).toISOString() }) + "\n");
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native,
      conversationStorage: f.storage, ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "10.0.0.3", role: "viewer" }]) }),
      createAdapter: async () => new MockAgentAdapter() });
    cleanup.push(() => app.close());
    const request = (ip: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url, remoteAddress: ip, ...(payload ? { payload } : {}) });
    const projects = (await request("10.0.0.1", "GET", "/v1/projects")).json();
    const project = projects.find((p: { cwd: string }) => p.cwd === sharedCwd);
    expect(project.canCreateSession).toBe(true);
    expect((await request("10.0.0.3", "GET", "/v1/projects")).json().find((p: { id: string }) => p.id === project.id).canCreateSession).toBe(false);
    expect((await request("10.0.0.3", "POST", "/v1/sessions", { projectId: project.id })).statusCode).toBe(403);
    const a = (await request("10.0.0.1", "POST", "/v1/sessions", { projectId: project.id })).json();
    const b = (await request("10.0.0.2", "POST", "/v1/sessions", { projectId: project.id })).json();
    expect(a.ownerKey).toBe("ip:10.0.0.1"); expect(b.ownerKey).toBe("ip:10.0.0.2");
    for (const [actor, other] of [["10.0.0.1", b], ["10.0.0.2", a]] as const) {
      expect((await request(actor, "GET", `/v1/sessions?projectId=${project.id}`)).json().some((s: { id: string }) => s.id === other.id)).toBe(false);
      for (const suffix of ["/export", "/events", "/file-preview?path=fixture.txt"]) expect((await request(actor, "GET", `/v1/sessions/${other.id}${suffix}`)).statusCode).toBe(404);
      expect((await request(actor, "DELETE", `/v1/sessions/${other.id}`)).statusCode).toBe(404);
      expect((await request(actor, "POST", `/v1/sessions/${other.id}/messages`, { requestId: "no", prompt: "no" })).statusCode).toBe(404);
      expect((await request(actor, "DELETE", `/v1/projects/${project.id}`)).statusCode).toBe(404);
    }
    const policyDenied = vi.spyOn(f.native, "allows").mockResolvedValue(false);
    expect((await request("10.0.0.4", "POST", "/v1/sessions", { projectId: project.id })).statusCode).toBe(404);
    expect((await request("10.0.0.1", "POST", "/v1/sessions", { projectId: project.id })).statusCode).toBe(201);
    policyDenied.mockRestore();
    const shared = (await f.sessions.listByProject("ip:10.0.0.1", project.id)).find(s => s.visibility === "shared")!;
    expect((await request("10.0.0.1", "DELETE", `/v1/sessions/${shared.id}`)).statusCode).toBe(204);
    expect((await request("10.0.0.1", "POST", "/v1/sessions", { projectId: project.id })).statusCode).toBe(201);
    expect((await request("10.0.0.4", "POST", "/v1/sessions", { projectId: project.id })).statusCode).toBe(404);
  });
  it("uses current default cwd after restart, repairing only historical shared native metadata", async () => {
    const f = await fixture();
    await f.native.discoverProjects();
    const original = (await f.sessions.listByOwner("any"))[0]!;
    expect(original.projectId).toBe(DEFAULT_PROJECT_ID);
    const bytes = readFileSync(f.file);
    await f.sessions.create({ ...original, id: "private-a", ownerKey: "ip:10.0.0.1", visibility: "private", origin: "managed", conversationRef: null });
    const cwdB = path.join(f.root, "B"); mkdirSync(cwdB);
    const dirB = path.join(f.source.root, nativeProjectDirectory(cwdB)); mkdirSync(dirB);
    writeFileSync(path.join(dirB, "b.jsonl"), JSON.stringify({ type: "session", version: 3, id: "b", cwd: cwdB }) + "\n");
    // ensureDefaultProject deliberately retains the old DB row; config is authoritative.
    await f.projects.ensureDefaultProject({ id: DEFAULT_PROJECT_ID, name: "Default B", cwd: cwdB, ownerKey: "", createdAt: 1 });
    expect((await f.projects.get(DEFAULT_PROJECT_ID))!.cwd).toBe(f.cwd);
    const index = new KyselyNativeSessionIndex(f.kysely, "sqlite", { defaultProjectCwd: cwdB });
    const native = new NativeSessionService(f.source, index, randomUUID);
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: cwdB, nativeSessions: native,
      conversationStorage: f.storage, ipAccess: makeTestIpAccess(), createAdapter: async () => new MockAgentAdapter() });
    cleanup.push(() => app.close());
    const list = (await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.2" })).json();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual(expect.objectContaining({ id: DEFAULT_PROJECT_ID, cwd: cwdB, canCreateSession: true }));
    const a = list.find((p: { cwd: string }) => p.cwd === f.cwd);
    expect(a).toMatchObject({ isDefault: false, canCreateSession: true });
    const repaired = (await f.sessions.get(original.id))!;
    expect(repaired.projectId).toBe(a.id);
    expect(repaired.conversationRef).toBe(original.conversationRef);
    expect((await f.sessions.get("private-a"))!.projectId).toBe(DEFAULT_PROJECT_ID);
    expect((await f.sessions.listByOwner("any")).find(s => s.id !== original.id)!.projectId).toBe(DEFAULT_PROJECT_ID);
    for (const record of await f.sessions.listByOwner("any")) {
      const exported = await app.inject({ method: "GET", url: `/v1/sessions/${record.id}/export`, remoteAddress: "10.0.0.2" });
      expect(exported.statusCode).toBe(200);
      const continued = await app.inject({ method: "POST", url: `/v1/sessions/${record.id}/messages`, remoteAddress: "10.0.0.2",
        payload: { requestId: randomUUID(), prompt: "continue fixture" } });
      expect(continued.statusCode).toBe(202);
    }
    expect(readFileSync(f.file)).toEqual(bytes);
    await new NativeSessionService(f.source, index, randomUUID).discoverProjects();
    expect(await f.projects.listRegistered()).toHaveLength(2);
    expect((await f.sessions.get(original.id))!.projectId).toBe(a.id);
    const denied = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.2", payload: { projectId: a.id } });
    expect(denied.statusCode).toBe(201);
    expect(denied.json().ownerKey).toBe("ip:10.0.0.2");
  });
  it("discovers header-authorized workspaces atomically, filters zero/invalid/excluded, and survives restart/tombstones", async () => {
    const f = await fixture();
    rmSync(f.file);
    const make = (name: string, version = 3) => {
      const cwd = path.join(f.root, name); mkdirSync(cwd);
      const directory = path.join(f.source.root, nativeProjectDirectory(cwd)); mkdirSync(directory);
      const file = path.join(directory, "session.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", version, id: name, cwd }) + "\n");
      return { cwd, file };
    };
    const eligible = make("eligible"); const excluded = make("excluded"); make("legacy", 2);
    const invalid = make("invalid"); writeFileSync(invalid.file, "bad\n");
    mkdirSync(path.join(f.source.root, "--empty--"));
    const symlink = make("symlink"); rmSync(symlink.file); symlinkSync(eligible.file, symlink.file);
    const source = new NativeSessionSource(f.source.root, new NativeSessionPolicy([excluded.cwd]));
    const native = new NativeSessionService(source, f.index, randomUUID);
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: native,
      ipAccess: makeTestIpAccess(), createAdapter: async () => new MockAgentAdapter() });
    cleanup.push(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.2" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({ name: "eligible", cwd: eligible.cwd, canDelete: false })]);
    expect(await f.projects.listRegistered()).toHaveLength(2);
    const project = response.json()[0];
    await expect(f.projects.create({ id: randomUUID(), name: "duplicate", cwd: eligible.cwd, ownerKey: "other", createdAt: 1 })).rejects.toMatchObject({ statusCode: 409 });
    const restarted = new NativeSessionService(source, new KyselyNativeSessionIndex(f.kysely, "sqlite"), randomUUID);
    await restarted.discoverProjects();
    expect(await f.projects.listRegistered()).toHaveLength(2);
    const session = (await f.sessions.listByOwner("other"))[0]!;
    await f.sessions.delete(session.id);
    await new NativeSessionService(source, f.index, randomUUID).discoverProjects();
    expect(await f.sessions.listByOwner("other")).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.2" })).json()).toEqual([]);
    expect(await f.projects.get(project.id)).not.toBeNull();
    expect(existsSync(eligible.file)).toBe(true);
  });

  it("keeps private projects actor-scoped when shared native discovery reuses their canonical cwd", async () => {
    const f = await fixture(); rmSync(f.file);
    const cwd = path.join(f.root, "owned"); mkdirSync(cwd);
    await f.projects.create({ id: "owned", name: "Owned", cwd, ownerKey: "ip:10.0.0.1", createdAt: 1 });
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native,
      ipAccess: makeTestIpAccess(), createAdapter: async () => new MockAgentAdapter() }); cleanup.push(() => app.close());
    const privateCreated = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.1", payload: { projectId: "owned", title: "private secret" } });
    expect(privateCreated.statusCode).toBe(201);
    const directory = path.join(f.source.root, nativeProjectDirectory(cwd)); mkdirSync(directory);
    writeFileSync(path.join(directory, "shared.jsonl"), JSON.stringify({ type: "session", version: 3, id: "shared-owned", cwd }) + "\n");
    const other = await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.2" });
    expect(other.json()).toEqual([expect.objectContaining({ id: "owned", canDelete: false })]);
    const otherSessions = await app.inject({ method: "GET", url: "/v1/sessions?projectId=owned", remoteAddress: "10.0.0.2" });
    expect(otherSessions.json()).toHaveLength(1);
    expect(otherSessions.body).not.toContain("private secret");
    expect(await f.projects.listRegistered()).toHaveLength(2);
    const shared = (await f.sessions.listByOwner("ip:10.0.0.2"))[0]!;
    await f.sessions.delete(shared.id);
    expect((await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.2" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.1" })).json()).toHaveLength(1);
  });

  it("never creates a tombstoned-only project after project deletion or accepts encoded-directory collisions", async () => {
    const f = await fixture(); rmSync(f.file);
    const cwd = path.join(f.root, "gone"); mkdirSync(cwd);
    const directory = path.join(f.source.root, nativeProjectDirectory(cwd)); mkdirSync(directory);
    const file = path.join(directory, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "gone", cwd }) + "\n");
    await f.native.discoverProjects();
    const project = (await f.projects.listRegistered()).find(p => p.cwd === cwd)!;
    await f.projects.delete(project.id);
    await new NativeSessionService(f.source, f.index, randomUUID).discoverProjects();
    expect(await f.projects.listRegistered()).toHaveLength(1);
    const wrong = path.join(f.root, "wrong"); mkdirSync(wrong);
    writeFileSync(path.join(directory, "mismatch.jsonl"), JSON.stringify({ type: "session", version: 3, id: "mismatch", cwd: wrong }) + "\n");
    await new NativeSessionService(f.source, f.index, randomUUID).discoverProjects();
    expect(await f.projects.listRegistered()).toHaveLength(1);
  });

  it("advances discovery pages beyond the first budget and caches completed sweeps", async () => {
    const f = await fixture(); rmSync(f.file);
    const directory = path.dirname(f.file);
    for (let i = 0; i < 140; i++) writeFileSync(path.join(directory, `${i}.jsonl`), "invalid\n");
    writeFileSync(path.join(directory, "last.jsonl"), JSON.stringify({ type: "session", version: 3, id: "last", cwd: f.cwd }) + "\n");
    const workspaces = vi.spyOn(f.source, "workspaces");
    await f.native.discoverProjects();
    await f.native.discoverProjects();
    expect(await f.sessions.listByOwner("other")).toHaveLength(1);
    await f.native.discoverProjects();
    expect(workspaces).toHaveBeenCalledTimes(1);
  });

  it.each(["id", "cwd", "symlink", "fifo"])("private preview checks durable source binding without a runtime: %s", async mutation => {
    const f = await fixture();
    const binding = { ...(await f.source.scan(canonicalCwdIdentity(f.cwd))).sources[0]!.binding, private: true };
    await f.sessions.create({ id: "private-preview", ownerKey: "ip:10.0.0.1", projectId: DEFAULT_PROJECT_ID, title: "private", visibility: "private", origin: "managed", createdAt: 0, updatedAt: 0,
      agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: f.file, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
    await f.index.reservePrivate(DEFAULT_PROJECT_ID, binding, "private-preview");
    await f.index.finalizePrivate(binding, "private-preview");
    writeFileSync(path.join(f.cwd, "safe.txt"), "private preview");
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native,
      ipAccess: makeTestIpAccess(), createAdapter: async () => { throw new Error("preview must not create runtime"); } });
    cleanup.push(() => app.close());
    const preview = () => app.inject({ method: "GET", url: "/v1/sessions/private-preview/file-preview?path=safe.txt", remoteAddress: "10.0.0.1" });
    expect((await preview()).statusCode).toBe(200);
    const other = path.join(f.root, "other-project"); mkdirSync(other); writeFileSync(path.join(other, "safe.txt"), "secret");
    if (mutation === "id" || mutation === "cwd") {
      writeFileSync(f.file, JSON.stringify({ type: "session", version: 3, id: mutation === "id" ? "replacement" : binding.sourceId, cwd: mutation === "cwd" ? other : f.cwd }) + "\n");
    } else {
      rmSync(f.file);
      if (mutation === "symlink") {
        const target = path.join(f.root, "replacement.jsonl");
        writeFileSync(target, JSON.stringify({ type: "session", version: 3, id: binding.sourceId, cwd: other }) + "\n");
        symlinkSync(target, f.file);
      } else execFileSync("mkfifo", [f.file]);
    }
    const denied = await preview();
    expect(denied.statusCode).not.toBe(200); expect(denied.body).not.toContain("secret");
  });

  it("idle same-inode edits invalidate the live FD heartbeat, replay and old runtime", async () => {
    const f = await fixture(); await f.native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd });
    const record = (await f.sessions.listByOwner("any"))[0]!;
    const adapter = new MockAgentAdapter(); const dispose = vi.spyOn(adapter, "dispose");
    const writer = openNativeSessionManager(f.source, (await f.index.binding(record.id))!);
    cleanup.push(async () => writer.descriptor.close());
    const registry = new RuntimeRegistry({ concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 2, perUserQueueLimit: 2, queueTimeoutMs: 1000 }), createAdapter: async () => adapter });
    cleanup.push(async () => registry.dispose());
    const service = new SessionService({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native, registry, createId: randomUUID, now: Date.now });
    const live = (await service.getEntry("one", record.id))!;
    const output = vi.fn(); const closed = vi.fn(); live.events.subscribe(output); live.events.registerClose(closed);
    writer.manager.appendSessionInfo("own append");
    const heartbeat = await service.prepareOutputGuard("one", record.id);
    expect(heartbeat()).toBe(true);
    live.events.push({ type: "text_delta", text: "before edit" }); expect(output).toHaveBeenCalledTimes(1);
    const before = statSync(f.file);
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace("own append", "CLI append"));
    expect(statSync(f.file).ino).toBe(before.ino); expect(statSync(f.file).size).toBe(before.size);
    expect(heartbeat()).toBe(false); expect(closed).toHaveBeenCalledTimes(1);
    live.events.subscribe(output, 0); live.events.push({ type: "text_delta", text: "after edit" });
    expect(output).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(registry.get(record.id)).toBeUndefined();
    await expect(live.runtime.submitMessage({ requestId: "stale", userId: "one", prompt: "denied" })).rejects.toThrow("会话已删除");
  });
  it("reserves private source path and original ID before file creation; deletion keeps a scanner tombstone", async () => {
    const f = await fixture();
    const binding = { ...(await f.source.scan(canonicalCwdIdentity(f.cwd))).sources[0]!.binding,
      sourceId: "new-private-original", sourcePath: path.join(path.dirname(f.file), "new-private.jsonl"), sourceDev: -1, sourceIno: -1, private: true };
    await f.sessions.create({ id: "private-web", ownerKey: "owner", projectId: DEFAULT_PROJECT_ID, title: "private", createdAt: 0, updatedAt: 0,
      agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
    await f.index.reservePrivate(DEFAULT_PROJECT_ID, binding, "private-web");
    expect(existsSync(binding.sourcePath)).toBe(false);
    writeFileSync(binding.sourcePath, JSON.stringify({ type: "session", version: 3, id: binding.sourceId, cwd: f.cwd }) + "\n");
    const candidate = (await f.source.scan(binding)).sources.find(source => source.binding.sourceId === binding.sourceId)!;
    await f.index.finalizePrivate(candidate.binding, "private-web");
    expect((await f.index.binding("private-web"))?.private).toBe(true);
    expect(await f.index.claim(DEFAULT_PROJECT_ID, candidate, "scanner-other")).toBeNull();
    expect(await f.index.claim(DEFAULT_PROJECT_ID, { ...candidate, binding: { ...candidate.binding, sourcePath: f.file } }, "scanner-alias")).toBeNull();
    expect(await f.sessions.listByOwner("other")).toEqual([]);
    await f.sessions.delete("private-web");
    const restarted = new KyselyNativeSessionIndex(f.kysely, "sqlite");
    expect(await restarted.claim(DEFAULT_PROJECT_ID, candidate, "scanner-restart")).toBeNull();
    await expect(restarted.finalizePrivate(candidate.binding, "private-web")).rejects.toThrow("retired");
    expect(existsSync(binding.sourcePath)).toBe(true);
  });
  it("v1 checksum/snapshot remains immutable; v2 records explicit shared/native defaults and retained source bindings", async () => {
    expect(migrationChecksum(migrationDefinitions[1]!)).toBe(MIGRATION_V1_GOLDEN_CHECKSUM);
    expect(migrationDefinitions[1]!.manifest.tables).toHaveLength(5);
    const f = await fixture();
    await Promise.all([f.native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd }), f.native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd })]);
    const a = await f.sessions.listByOwner("ip:10.0.0.1"); const b = await f.sessions.listByOwner("ip:10.0.0.2");
    expect(a).toHaveLength(1); expect(b[0]!.id).toBe(a[0]!.id); expect(a[0]).toMatchObject({ visibility: "shared", origin: "native" });
    expect(a[0]!.id).not.toBe("original");
    // Recreate service/index to simulate process restart without reassigning source IDs.
    const restarted = new NativeSessionService(f.source, new KyselyNativeSessionIndex(f.kysely, "sqlite"), randomUUID);
    await restarted.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd }); expect(await f.sessions.listByOwner("other")).toHaveLength(1);
    await f.sessions.delete(a[0]!.id);
    await restarted.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd }); expect(await f.sessions.listByOwner("other")).toEqual([]);
    expect(existsSync(f.file)).toBe(true);
    expect(f.db.prepare("SELECT deleted FROM native_session_sources").get()).toMatchObject({ deleted: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM file_operations").get()).toMatchObject({ n: 0 });
  });

  it("prevents new canonical cwd duplicates across owners/default/aliases while keeping existing duplicates", async () => {
    const f = await fixture(); const alias = path.join(f.root, "alias"); symlinkSync(f.cwd, alias);
    await expect(f.projects.create({ id: randomUUID(), name: "Alias", cwd: alias, ownerKey: "other", createdAt: 1 })).rejects.toMatchObject({ statusCode: 409 });
    const cwd = path.join(f.root, "second"); mkdirSync(cwd);
    await f.projects.create({ id: randomUUID(), name: "Second", cwd, ownerKey: "one", createdAt: 1 });
    await expect(f.projects.create({ id: randomUUID(), name: "Again", cwd, ownerKey: "two", createdAt: 1 })).rejects.toMatchObject({ statusCode: 409 });
    // Existing legacy duplicates are retained; no migration or registration deletes rows.
    await f.kysely.insertInto("projects").values({ id: randomUUID(), name: "Legacy", cwd, owner_key: "two", created_at: 0 }).execute();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toMatchObject({ n: 3 });
  });

  it("shared cross-user endpoints retain RBAC, private isolation, one runtime and actor-bound idempotency", async () => {
    const f = await fixture(); let creates = 0;
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, conversationStorage: f.storage,
      nativeSessions: f.native, ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "10.0.0.3", role: "viewer" }]) }),
      createAdapter: async () => { creates++; return new MockAgentAdapter(); } });
    cleanup.push(() => app.close());
    const list = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "10.0.0.1" });
    expect(list.statusCode).toBe(200); const id = list.json()[0].id;
    const request = (ip: string, method: "GET" | "POST" | "PATCH" | "DELETE", endpoint: string, payload?: object) => app.inject({ method, url: `/v1/sessions/${id}${endpoint}`, remoteAddress: ip, ...(payload ? { payload } : {}) });
    expect((await request("10.0.0.2", "GET", "/export")).statusCode).toBe(200); expect(creates).toBe(0);
    expect((await request("10.0.0.3", "GET", "/events")).statusCode).toBe(204);
    expect((await request("10.0.0.3", "POST", "/messages", { requestId: "viewer", prompt: "no" })).statusCode).toBe(403);
    expect((await request("10.0.0.1", "POST", "/messages", { requestId: "same", prompt: "yes" })).statusCode).toBe(202);
    expect((await request("10.0.0.2", "POST", "/messages", { requestId: "same", prompt: "yes" })).statusCode).toBe(409);
    expect((await request("10.0.0.2", "POST", "/abort")).statusCode).not.toBe(404); expect(creates).toBe(1);
    const created = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.1", payload: {} }); expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/v1/sessions/${created.json().id}/export`, remoteAddress: "10.0.0.2" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "10.0.0.2" })).json()).toHaveLength(1);
  });

  it("B first discovers A's registered cwd without exposing private sessions/projects", async () => {
    const f = await fixture(); const cwd = path.join(f.root, "owner-a"); mkdirSync(cwd);
    const projectId = randomUUID(); await f.projects.create({ id: projectId, name: "A", cwd, ownerKey: "ip:10.0.0.1", createdAt: 1 });
    const directory = path.join(f.source.root, nativeProjectDirectory(cwd)); mkdirSync(directory);
    const file = path.join(directory, "a.jsonl"); writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "a-native", cwd }) + "\n");
    await f.sessions.create({ id: "a-private", ownerKey: "ip:10.0.0.1", projectId, title: "private", visibility: "private", origin: "managed", createdAt: 0, updatedAt: 0,
      agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native, conversationStorage: f.storage,
      ipAccess: makeTestIpAccess(), createAdapter: async () => new MockAgentAdapter() }); cleanup.push(() => app.close());
    // Web-style first request: B lists projects before any owner has scanned A.
    const initialProjects = await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.2" });
    expect(initialProjects.json().some((project: any) => project.id === projectId)).toBe(true);
    const first = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "10.0.0.2" });
    expect(first.json().some((record: any) => record.projectId === projectId && record.origin === "native")).toBe(true);
    expect(first.json().some((record: any) => record.id === "a-private")).toBe(false);
    const listed = await app.inject({ method: "GET", url: "/v1/projects", remoteAddress: "10.0.0.2" });
    expect(listed.json().some((project: any) => project.id === projectId)).toBe(true);
  });

  it("scanner does not promote already-registered private Web source paths", async () => {
    const f = await fixture();
    await f.sessions.create({ id: "private-source", ownerKey: "one", projectId: DEFAULT_PROJECT_ID, title: "private", visibility: "private", origin: "managed", createdAt: 0, updatedAt: 0,
      agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: f.file, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
    await f.native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd });
    expect(await f.sessions.listByOwner("two")).toEqual([]); expect(await f.index.binding("private-source")).toBeNull();
  });

  it("latest native name wins first prompt, Web rename wins native name; cache invalidates on append", async () => {
    const f = await fixture(); await f.native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd }); const record = (await f.sessions.listByOwner("any"))[0]!;
    const binding = (await f.index.binding(record.id))!; const { manager, descriptor } = openNativeSessionManager(f.source, binding);
    manager.appendMessage({ role: "user", content: "first prompt", timestamp: 1 }); manager.appendSessionInfo("old name"); manager.appendSessionInfo("new name"); descriptor.close();
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: f.native, conversationStorage: f.storage,
      ipAccess: makeTestIpAccess(), createAdapter: async () => new MockAgentAdapter() }); cleanup.push(() => app.close());
    const list = async () => (await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "10.0.0.1" })).json()[0];
    expect((await list()).title).toBe("new name");
    const next = openNativeSessionManager(f.source, binding); next.manager.appendSessionInfo("latest name"); next.descriptor.close();
    expect((await list()).title).toBe("latest name");
    await app.inject({ method: "PATCH", url: `/v1/sessions/${record.id}`, remoteAddress: "10.0.0.1", payload: { title: "Web rename" } });
    expect((await list()).title).toBe("Web rename");
    expect((await f.sessions.get(record.id))!.title).toBe("Web rename");
  });

  it("revocation closes existing SSE, rejects replay and heartbeat guard, aborts runtime and denies append", async () => {
    const f = await fixture(); const excluded = path.join(f.root, "excluded"); mkdirSync(excluded);
    const source = new NativeSessionSource(f.source.root, new NativeSessionPolicy([excluded]));
    const native = new NativeSessionService(source, f.index, randomUUID); await native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd });
    const record = (await f.sessions.listByOwner("any"))[0]!;
    const adapter = new MockAgentAdapter(); let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    vi.spyOn(adapter, "prompt").mockImplementation(async () => pending);
    const abort = vi.spyOn(adapter, "abort").mockImplementation(async () => { settle(); });
    const registry = new RuntimeRegistry({ concurrency: new ConcurrencyController({ globalLimit: 2, perUserLimit: 2, globalQueueLimit: 2, perUserQueueLimit: 2, queueTimeoutMs: 1000 }), createAdapter: async () => adapter });
    cleanup.push(async () => registry.dispose());
    const service = new SessionService({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: native, registry, createId: randomUUID, now: Date.now });
    const live = (await service.getEntry("one", record.id))!;
    await live.runtime.submitMessage({ requestId: "active", userId: "one", prompt: "held run" });
    await new Promise(resolve => setTimeout(resolve, 0));
    const output = vi.fn(); const closed = vi.fn();
    live.events.subscribe(output); live.events.registerClose(closed);
    live.events.push({ type: "text_delta", text: "allowed" }); expect(output).toHaveBeenCalledTimes(1);
    const heartbeat = await service.prepareOutputGuard("one", record.id);
    const writer = openNativeSessionManager(source, (await f.index.binding(record.id))!);
    rmSync(excluded, { recursive: true });
    expect(heartbeat()).toBe(false); expect(closed).toHaveBeenCalledTimes(1);
    live.events.push({ type: "text_delta", text: "revoked" }); live.events.subscribe(output, 0);
    expect(output).toHaveBeenCalledTimes(1); expect(() => writer.manager.appendSessionInfo("no-write")).toThrow(); writer.descriptor.close();
    await new Promise(resolve => setTimeout(resolve, 0)); expect(abort).toHaveBeenCalled(); expect(registry.get(record.id)).toBeUndefined();
  });

  it("an established HTTP SSE heartbeat closes on policy revocation without writing another byte", async () => {
    const f = await fixture(); const excluded = path.join(f.root, "excluded-heartbeat"); mkdirSync(excluded);
    const source = new NativeSessionSource(f.source.root, new NativeSessionPolicy([excluded]));
    const native = new NativeSessionService(source, f.index, randomUUID);
    await native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd });
    const id = (await f.sessions.listByOwner("any"))[0]!.id;
    const writes: string[] = []; let ping!: () => void; let ready!: () => void;
    const established = new Promise<void>(resolve => { ready = resolve; });
    const originalInterval = globalThis.setInterval;
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
      if (delay !== 15000) return originalInterval(callback, delay);
      ping = callback; ready(); return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const adapter = new MockAgentAdapter(); const dispose = vi.spyOn(adapter, "dispose");
    const registry = new RuntimeRegistry({ concurrency: new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 2, perUserQueueLimit: 2, queueTimeoutMs: 1000 }), createAdapter: async () => adapter });
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: native,
      conversationStorage: f.storage, ipAccess: makeTestIpAccess(), registry, createAdapter: async () => adapter,
      sseSocketFactory: (reply, request) => ({ writeHead: (status, headers) => reply.writeHead(status, headers),
        flushHeaders: () => reply.flushHeaders(), write: data => { writes.push(data); return true; },
        end: () => reply.end(), onClose: callback => request.on("close", callback) }),
    });
    try {
      const response = app.inject({ method: "GET", url: `/v1/sessions/${id}/events`, remoteAddress: "10.0.0.1" });
      await established; const live = registry.get(id)!;
      ping(); expect(writes).toEqual([": ping\n\n"]);
      rmSync(excluded, { recursive: true }); ping(); await response;
      ping(); expect(writes).toEqual([": ping\n\n"]);
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(registry.get(id)).toBeUndefined();
      await expect(live.runtime.submitMessage({ requestId: "stale", userId: "one", prompt: "denied" })).rejects.toThrow("会话已删除");
      expect(dispose).toHaveBeenCalledTimes(1); // Before app.close: idle lifecycle abort may return conflict.
    } finally { interval.mockRestore(); await app.close(); }
  });

  it("HTTP revocation aborts a held streaming prompt, cancels queued work and preserves the original", async () => {
    const f = await fixture(); const excluded = path.join(f.root, "excluded-stream"); mkdirSync(excluded);
    const source = new NativeSessionSource(f.source.root, new NativeSessionPolicy([excluded]));
    const native = new NativeSessionService(source, f.index, randomUUID);
    const queuedFile = path.join(path.dirname(f.file), "queued.jsonl");
    writeFileSync(queuedFile, JSON.stringify({ type: "session", version: 3, id: "queued-original", cwd: f.cwd }) + "\n");
    await native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd });
    const records = await f.sessions.listByOwner("any");
    const id = records.find(record => record.conversationRef === f.file)!.id;
    const queuedId = records.find(record => record.conversationRef === queuedFile)!.id;
    const queuedOriginal = readFileSync(queuedFile);
    const original = readFileSync(f.file); const size = statSync(f.file).size;
    const adapter = new MockAgentAdapter(); let settle!: () => void; let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { settle = resolve; });
    const prompt = vi.spyOn(adapter, "prompt").mockImplementation(async () => { started(); await held; });
    const abort = vi.spyOn(adapter, "abort").mockImplementation(async () => { settle(); });
    const dispose = vi.spyOn(adapter, "dispose");
    const concurrency = new ConcurrencyController({ globalLimit: 1, perUserLimit: 1, globalQueueLimit: 2, perUserQueueLimit: 2, queueTimeoutMs: 10000 });
    const queuedAdapter = new MockAgentAdapter(); const queuedPrompt = vi.spyOn(queuedAdapter, "prompt");
    const queuedDispose = vi.spyOn(queuedAdapter, "dispose");
    const registry = new RuntimeRegistry({ concurrency, createAdapter: async sessionId => sessionId === id ? adapter : queuedAdapter });
    const writes: string[] = []; let ping!: () => void; let ready!: () => void;
    const established = new Promise<void>(resolve => { ready = resolve; });
    const originalInterval = globalThis.setInterval;
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
      if (delay !== 15000) return originalInterval(callback, delay);
      ping = callback; ready(); return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: native,
      conversationStorage: f.storage, ipAccess: makeTestIpAccess(), registry, concurrency, createAdapter: async () => adapter,
      sseSocketFactory: (reply, request) => ({ writeHead: (status, headers) => reply.writeHead(status, headers),
        flushHeaders: () => reply.flushHeaders(), write: data => { writes.push(data); return true; },
        end: () => reply.end(), onClose: callback => request.on("close", callback) }),
    });
    try {
      const response = app.inject({ method: "GET", url: `/v1/sessions/${id}/events`, remoteAddress: "10.0.0.1" });
      await established;
      const send = (requestId: string) => app.inject({ method: "POST", url: `/v1/sessions/${id}/messages`, remoteAddress: "10.0.0.1", payload: { requestId, prompt: requestId } });
      expect((await send("active-http")).statusCode).toBe(202); await running;
      const queued = await app.inject({ method: "POST", url: `/v1/sessions/${queuedId}/messages`, remoteAddress: "10.0.0.1", payload: { requestId: "queued-http", prompt: "queued" } });
      expect(queued.statusCode).toBe(202);
      expect(concurrency.queuedCount()).toBe(1);
      const live = registry.get(id)!; ping(); const bytesBefore = writes.join("");
      rmSync(excluded, { recursive: true });
      // Revalidate the queued native session before releasing the active slot.
      expect((await app.inject({ method: "GET", url: `/v1/sessions/${queuedId}/export`, remoteAddress: "10.0.0.1" })).statusCode).toBe(404);
      await vi.waitFor(() => expect(queuedDispose).toHaveBeenCalledTimes(1));
      expect(registry.get(queuedId)).toBeUndefined(); expect(queuedPrompt).not.toHaveBeenCalled();
      ping(); await response;
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(abort).toHaveBeenCalledTimes(1); expect(registry.get(id)).toBeUndefined();
      expect(concurrency.queuedCount()).toBe(0); expect(concurrency.activeCount()).toBe(0);
      expect(prompt).toHaveBeenCalledTimes(1);
      await expect(live.runtime.submitMessage({ requestId: "old-http", userId: "one", prompt: "denied" })).rejects.toThrow("会话已删除");
      expect((await send("revoked-http")).statusCode).toBe(404);
      live.events.push({ type: "text_delta", text: "late forbidden output" }); ping();
      expect(writes.join("")).toBe(bytesBefore);
      expect(statSync(f.file).size).toBe(size); expect(readFileSync(f.file)).toEqual(original);
      expect(readFileSync(queuedFile)).toEqual(queuedOriginal);
    } finally { interval.mockRestore(); settle(); await app.close(); }
  });

  it("already-indexed sources are denied on all session endpoints after exclusion, without deleting originals", async () => {
    const f = await fixture(); await f.native.discover({ id: DEFAULT_PROJECT_ID, cwd: f.cwd }); const id = (await f.sessions.listByOwner("any"))[0]!.id;
    const blocked = new NativeSessionService(new NativeSessionSource(f.source.root, new NativeSessionPolicy([f.cwd])), f.index, randomUUID);
    const app = buildApp({ sessions: f.sessions, projects: f.projects, defaultProjectCwd: f.cwd, nativeSessions: blocked,
      conversationStorage: f.storage, ipAccess: makeTestIpAccess(), createAdapter: async () => { throw new Error("must not create"); } }); cleanup.push(() => app.close());
    expect((await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "10.0.0.1" })).json()).toEqual([]);
    const cases: Array<["GET" | "POST" | "PATCH" | "DELETE", string, object?]> = [
      ["GET", "/export"], ["GET", "/events"], ["GET", "/file-preview?path=a"], ["DELETE", ""],
      ["PATCH", "", { title: "x" }], ["PATCH", "/config", { thinkingLevel: "low" }],
      ["POST", "/messages", { requestId: "x", prompt: "x" }], ["POST", "/steer", { text: "x" }],
      ["POST", "/follow-ups", { text: "x" }], ["POST", "/abort"],
    ];
    for (const [method, endpoint, payload] of cases) {
      const response = await app.inject({ method, url: `/v1/sessions/${id}${endpoint}`, remoteAddress: "10.0.0.1", ...(payload ? { payload } : {}) });
      expect(response.statusCode, endpoint).toBe(404);
    }
    expect(existsSync(f.file)).toBe(true); expect(await f.sessions.get(id)).not.toBeNull();
  });
});
