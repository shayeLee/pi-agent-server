import { expect, it, vi } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const io = vi.hoisted(() => ({ bytes: 0, reads: 0 }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readSync: (...args: Parameters<typeof fs.readSync>) => {
    const count = fs.readSync(...args); io.bytes += count; io.reads++; return count;
  } };
});
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, appendFileSync, symlinkSync, renameSync } from "node:fs";
import { NativeSessionSource, nativeProjectDirectory } from "../../src/agent/native-session-source.js";
import { NativeSessionPolicy, canonicalCwdIdentity } from "../../src/core/native-session-policy.js";
import { NativeSessionService } from "../../src/application/native-session-service.js";
import { KyselyNativeSessionIndex } from "../../src/storage/kysely-native-session-index.js";
import { NativePiConversationStorage, NATIVE_METADATA_MAX_BYTES, NATIVE_METADATA_TAIL_BYTES } from "../../src/agent/native-pi-conversation-storage.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { buildApp } from "../../src/server/app.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";
import { resolveSessionDisplayTitle } from "../../src/client/session-title.js";

it("lists native, unified private and legacy titles before opening, with bounded aggregate cold/warm IO", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-title-list-")));
  const cwd = path.join(root, "cwd"); mkdirSync(cwd);
  const nativeRoot = path.join(root, "native");
  const dir = path.join(nativeRoot, nativeProjectDirectory(cwd)); mkdirSync(dir, { recursive: true });
  const db = await makeInitializedMemoryDb({ cwd, dataDir: root });
  const source = new NativeSessionSource(nativeRoot, new NativeSessionPolicy([]));
  const index = new KyselyNativeSessionIndex(db.kysely, "sqlite", { defaultProjectCwd: cwd });
  const native = new NativeSessionService(source, index, randomUUID);
  const storage = new ConversationStorageRegistry();
  storage.register(new NativePiConversationStorage(source, index));
  storage.register(new PiJsonlConversationStorage(root, { source, index }));
  const adapter = vi.fn(async () => { throw new Error("must not open runtime"); });
  const app = buildApp({ sessions: db.sessions, projects: db.projects, defaultProjectCwd: cwd, nativeSessions: native,
    conversationStorage: storage, ipAccess: makeTestIpAccess(), createAdapter: adapter });
  const record = (id: string, file: string, title = "") => ({ id, title, ownerKey: "ip:10.0.0.1", projectId: DEFAULT_PROJECT_ID,
    createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: file,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n";
  const user = (text: string) => JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: text } }) + "\n";
  const name = (text: string) => JSON.stringify({ type: "session_info", id: "n", parentId: "u", name: text }) + "\n";
  const padding = JSON.stringify({ type: "custom", id: "pad", parentId: "u", data: "x".repeat(2 * 1024 * 1024) }) + "\n";
  const list = async () => {
    const response = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "10.0.0.1" });
    expect(response.statusCode).toBe(200); return response.json();
  };
  try {
    const n = 12;
    const longPrompt = "长".repeat(20_000); // ~60 KB JSONL user content, below the per-record budget.
    const attachment = JSON.stringify({ type: "custom_message", id: "attachment", parentId: null, customType: "attachment", content: "not a user prompt" }) + "\n";
    for (let i = 0; i < n; i++) writeFileSync(path.join(dir, `${i}.jsonl`), header(`native-${i}`) +
      (i === 0 ? attachment : "") + user(i === 0 ? longPrompt : `prompt-${i}`) + padding + (i % 2 ? name(`name-${i}`) : ""));
    await native.discover({ id: DEFAULT_PROJECT_ID, cwd });
    const privateFile = path.join(dir, "private.jsonl");
    await db.sessions.create(record("private", privateFile));
    // Durable claim precedes the file, exactly as the writer's private path does.
    const exemplar = (await source.scan(canonicalCwdIdentity(cwd))).sources[0]!.binding;
    const reserved = { ...exemplar, sourceId: "private-source", sourcePath: privateFile, private: true };
    await index.reservePrivate(DEFAULT_PROJECT_ID, reserved, "private");
    writeFileSync(privateFile, header("private-source") + user("private prompt") + name("private native name"));
    const actual = (await source.scan(reserved)).sources.find(candidate => candidate.binding.sourcePath === privateFile)!.binding;
    await index.finalizePrivate(actual, "private");
    const legacyDir = path.join(root, "sessions", "legacy"); mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, "old.jsonl"); writeFileSync(legacyFile, header("legacy") + user("legacy prompt"));
    await db.sessions.create(record("legacy", legacyFile));
    io.bytes = 0; io.reads = 0; const started = performance.now();
    let rows = await list();
    const cold = { bytes: io.bytes, reads: io.reads, ms: performance.now() - started };
    expect(rows).toHaveLength(n + 2);
    for (let i = 0; i < n; i++) {
      const prompt = i === 0 ? longPrompt.slice(0, 512) : `prompt-${i}`;
      const row = rows.find((row: { title: string; firstPrompt?: string }) => row.title === `name-${i}` || row.firstPrompt === prompt);
      expect(row).toBeDefined();
      expect(resolveSessionDisplayTitle(row)).toBe(i % 2 ? `name-${i}` : prompt);
      if (i === 0) expect(row.firstPrompt).toHaveLength(512);
    }
    expect(rows.find((row: { id: string }) => row.id === "private").title).toBe("private native name");
    expect(rows.find((row: { id: string }) => row.id === "legacy").firstPrompt).toBe("legacy prompt");
    expect(cold.bytes).toBeLessThan((n + 2) * (NATIVE_METADATA_MAX_BYTES + NATIVE_METADATA_TAIL_BYTES + 8 * 16 * 1024));
    io.bytes = 0; io.reads = 0; await list();
    console.info("title list IO", { sessions: n + 2, cold, warm: { bytes: io.bytes, reads: io.reads } });
    expect(io.bytes).toBeLessThan(cold.bytes / 4);
    await db.sessions.update("private", { title: "未命名会话" });
    expect((await list()).find((row: { id: string }) => row.id === "private").title).toBe("未命名会话");
    await db.sessions.update("private", { title: "" });
    appendFileSync(privateFile, JSON.stringify({ type: "session_info", id: "n2", parentId: "n", name: "updated name" }) + "\n");
    expect((await list()).find((row: { id: string }) => row.id === "private").title).toBe("updated name");
    renameSync(privateFile, privateFile + ".old"); symlinkSync(privateFile + ".old", privateFile);
    rows = await list();
    expect(rows.find((row: { id: string }) => row.id === "private")).toMatchObject({ title: "", firstPrompt: null });
    expect(adapter).not.toHaveBeenCalled();
  } finally { await app.close(); await native.close(); await db.close(); rmSync(root, { recursive: true, force: true }); }
});
