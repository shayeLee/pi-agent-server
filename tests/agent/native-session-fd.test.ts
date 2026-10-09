import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
const io = vi.hoisted(() => ({ fds: new Set<number>(), short: false, fail: false, beforeOpen: undefined as (() => void) | undefined, beforeWrite: undefined as (() => void) | undefined, afterRead: undefined as (() => void) | undefined, reads: 0, writes: 0 }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => { const hook = io.beforeOpen; io.beforeOpen = undefined; hook?.(); const fd = fs.openSync(...args); io.fds.add(fd); return fd; },
    closeSync: (fd: number) => { io.fds.delete(fd); fs.closeSync(fd); },
    readSync: (...args: Parameters<typeof fs.readSync>) => { io.reads++; const count = fs.readSync(...args); const hook = io.afterRead; io.afterRead = undefined; hook?.(); return count; },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      io.writes++; const hook = io.beforeWrite; io.beforeWrite = undefined; hook?.(); if (io.fail) throw new Error("injected write failure");
      return fs.writeSync(fd, buffer, offset, io.short ? Math.max(1, length - 1) : length, position);
    },
  };
});
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, readFileSync, renameSync, symlinkSync, linkSync } from "node:fs";
import { NativeSessionSource, nativeProjectDirectory } from "../../src/agent/native-session-source.js";
import { NativeSessionPolicy, canonicalCwdIdentity } from "../../src/core/native-session-policy.js";
import { NativeSessionFd, nativeEntries, openNativeSessionManager, readNativeSourceSnapshot } from "../../src/agent/native-session-fd.js";
import { NativePiConversationStorage } from "../../src/agent/native-pi-conversation-storage.js";
const roots: string[] = [];
afterEach(() => {
  expect(io.fds.size).toBe(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  io.short = false; io.fail = false; io.beforeOpen = undefined; io.beforeWrite = undefined; io.afterRead = undefined; io.reads = 0; io.writes = 0;
});
async function fixture(excluded = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-fd-"))); roots.push(root);
  const cwd = path.join(root, "cwd"); mkdirSync(cwd);
  const exclusion = path.join(root, "excluded"); mkdirSync(exclusion);
  const sourceRoot = path.join(root, "sources"); const dir = path.join(sourceRoot, nativeProjectDirectory(cwd)); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pi.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id: "pi-id", cwd }) + "\n"; writeFileSync(file, header);
  const external = path.join(root, "external.jsonl"); writeFileSync(external, "outside-secret\n");
  const source = new NativeSessionSource(sourceRoot, new NativeSessionPolicy(excluded ? [exclusion] : []));
  const binding = (await source.scan(canonicalCwdIdentity(cwd))).sources[0]!.binding;
  return { root, cwd, exclusion, sourceRoot, dir, file, header, external, source, binding };
}

describe("native descriptor authority", () => {
  it("persists all SDK append families including label, compaction, context edit and extension startup with original header/id", async () => {
    const f = await fixture(); const { manager, descriptor } = openNativeSessionManager(f.source, f.binding);
    try {
      expect(manager.getSessionId()).toBe("pi-id"); expect(manager.getSessionFile()).toBe(f.file);
      const user = manager.appendMessage({ role: "user", content: "prompt", timestamp: 1 });
      manager.appendThinkingLevelChange("low"); manager.appendModelChange("fake", "fake");
      manager.appendSessionInfo("native title"); manager.appendCustomEntry("extension-start", { ready: true });
      manager.appendCustomMessageEntry("custom", "note", true); manager.appendLabelChange(user, "label");
      manager.appendContextEdit(user, { content: "edited prompt" });
      manager.appendCompaction("summary", user, 10); manager.branchWithSummary(user, "branch summary");
      manager.appendUsage("compaction", "fake", "fake", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
      expect(readFileSync(f.file, "utf8").startsWith(f.header)).toBe(true);
      expect(nativeEntries(descriptor).length).toBe(12);
      expect(io.writes).toBe(11);
      const storage = new NativePiConversationStorage(f.source, { binding: async () => f.binding, claim: async () => null });
      expect(await storage.readFirstPrompt({ agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file }, { sessionId: "server", projectId: "project" })).toBe("prompt");
      for (const method of ["newSession", "setSessionFile", "createBranchedSession", "_rewriteFile", "_setSessionFile", "_loadEntries"]) {
        expect(() => (manager as any)[method](f.external)).toThrow("forbidden");
      }
      expect(readFileSync(f.external, "utf8")).toBe("outside-secret\n");
    } finally { descriptor.close(); }
  });

  it.each(["file", "directory", "root", "ancestor"])("rejects %s symlink swap before append; never writes external fixture", async level => {
    const f = await fixture(); const { manager, descriptor } = openNativeSessionManager(f.source, f.binding);
    let poison = 0; descriptor.onPoison = () => poison++;
    if (level === "file") { renameSync(f.file, f.file + ".old"); symlinkSync(f.external, f.file); }
    else {
      const target = level === "directory" ? f.dir : level === "root" ? f.sourceRoot : f.root;
      renameSync(target, target + ".old");
      symlinkSync(target + ".old", target);
      if (level === "ancestor") roots.push(f.root + ".old");
    }
    expect(() => manager.appendCustomEntry("must-not-write", {})).toThrow();
    expect(() => manager.appendSessionInfo("no retry")).toThrow();
    expect(poison).toBe(1); expect(io.writes).toBe(0);
    expect(readFileSync(f.external, "utf8")).toBe("outside-secret\n"); descriptor.close();
  });

  it("swap inside write still appends only to pinned FD and poisons after validation", async () => {
    const f = await fixture(); const { manager, descriptor } = openNativeSessionManager(f.source, f.binding);
    io.beforeWrite = () => { renameSync(f.file, f.file + ".old"); symlinkSync(f.external, f.file); };
    expect(() => manager.appendCustomEntry("pinned-fd", {})).toThrow("invalidated");
    expect(readFileSync(f.file + ".old", "utf8")).toContain("pinned-fd");
    expect(readFileSync(f.external, "utf8")).toBe("outside-secret\n");
    expect(() => descriptor.check()).toThrow(); descriptor.close();
  });

  it("validates opened inode before reading when path changes inside open", async () => {
    const f = await fixture(); io.reads = 0;
    io.beforeOpen = () => { renameSync(f.file, f.file + ".old"); symlinkSync(f.external, f.file); };
    expect(() => new NativeSessionFd(f.source, f.binding, false)).toThrow(); expect(io.reads).toBe(0);
  });

  it("read snapshot stays on FD and rejects replacement during read without reading external data", async () => {
    const f = await fixture(); const fd = new NativeSessionFd(f.source, f.binding, false); io.reads = 0;
    io.afterRead = () => { renameSync(f.file, f.file + ".old"); symlinkSync(f.external, f.file); };
    expect(() => fd.snapshot()).toThrow(); expect(io.reads).toBe(1);
    expect(readFileSync(f.external, "utf8")).toBe("outside-secret\n"); fd.close();
  });

  it("export never reopens a substituted source path after validation", async () => {
    const f = await fixture(); const storage = new NativePiConversationStorage(f.source, { binding: async () => f.binding, claim: async () => null });
    io.reads = 0;
    io.beforeOpen = () => { renameSync(f.file, f.file + ".old"); symlinkSync(f.external, f.file); };
    await expect(storage.readExport({ agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file }, { sessionId: "server", projectId: "project" })).rejects.toThrow();
    expect(io.reads).toBe(0);
  });

  it.each(["short", "exception"])("%s write poisons permanently even if SDK already appended to memory", async mode => {
    const f = await fixture(); const { manager, descriptor } = openNativeSessionManager(f.source, f.binding);
    let poison = 0; descriptor.onPoison = () => poison++;
    io.short = mode === "short"; io.fail = mode === "exception";
    expect(() => manager.appendCustomEntry("fail", {})).toThrow("invalidated");
    io.short = false; io.fail = false;
    expect(() => manager.appendCustomEntry("retry", {})).toThrow();
    expect(() => descriptor.check()).toThrow(); expect(io.writes).toBe(1); expect(poison).toBe(1); descriptor.close();
  });

  it("denies hard links, same-inode external edits and vanished exclusions", async () => {
    const f = await fixture(true); const { manager, descriptor } = openNativeSessionManager(f.source, f.binding);
    linkSync(f.file, path.join(f.root, "hardlink")); expect(() => descriptor.check()).toThrow(); descriptor.close();
    rmSync(path.join(f.root, "hardlink"));
    const second = openNativeSessionManager(f.source, f.binding); writeFileSync(f.file, f.header + " ");
    expect(() => second.descriptor.check()).toThrow(); second.descriptor.close(); writeFileSync(f.file, f.header);
    const third = openNativeSessionManager(f.source, f.binding); rmSync(f.exclusion, { recursive: true });
    expect(() => third.manager.appendCustomEntry("revoked", {})).toThrow(); third.descriptor.close();
    expect(manager.getSessionId()).toBe("pi-id");
  });

  it("large title metadata cannot advertise a truncated older name as latest; v2 is never migrated", async () => {
    const f = await fixture(); const { manager, descriptor } = openNativeSessionManager(f.source, f.binding);
    manager.appendSessionInfo("old prefix title"); manager.appendCustomEntry("padding", "x".repeat(1024 * 1024)); manager.appendSessionInfo("latest suffix title"); descriptor.close();
    const storage = new NativePiConversationStorage(f.source, { binding: async () => f.binding, claim: async () => null });
    expect(await storage.readTitle({ agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file }, { sessionId: "server", projectId: "project" })).toBe("latest suffix title");
    // If the latest name lies outside the inspected suffix, do not reuse an
    // older prefix name or cache unknown as an authoritative empty title.
    const writer = openNativeSessionManager(f.source, f.binding);
    writer.manager.appendCustomEntry("later-padding", "x".repeat(1024 * 1024)); writer.descriptor.close();
    expect(await storage.readTitle({ agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file }, { sessionId: "server", projectId: "project" })).toBeNull();
    const legacy = f.header.replace('"version":3', '"version":2'); writeFileSync(f.file, legacy);
    expect(() => openNativeSessionManager(f.source, f.binding)).toThrow("unavailable"); expect(readFileSync(f.file, "utf8")).toBe(legacy);
  });

  it.each([0, 512 * 1024])("uses the opened snapshot when CLI appends after path stat (%i padding bytes)", async padding => {
    const f = await fixture();
    const writer = openNativeSessionManager(f.source, f.binding);
    writer.manager.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
    if (padding) writer.manager.appendCustomEntry("padding", "x".repeat(padding));
    writer.manager.appendSessionInfo("old title"); writer.descriptor.close();
    const storage = new NativePiConversationStorage(f.source, { binding: async () => f.binding, claim: async () => null });
    const conversation = { agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file };
    const context = { sessionId: "server", projectId: "project" };
    const allows = f.source.allowsBinding.bind(f.source);
    const validate = f.source.validate.bind(f.source);
    // Arm only after path/header validation; the constructor policy check is
    // after the old external cache stat but before its path stat/descriptor open.
    const validation = vi.spyOn(f.source, "validate").mockImplementation(binding => {
      const result = validate(binding);
      vi.spyOn(f.source, "allowsBinding").mockImplementationOnce(binding => {
        appendFileSync(f.file, JSON.stringify({ type: "session_info", id: "latest", parentId: null, name: "latest CLI title" }) + "\n");
        return allows(binding);
      });
      return result;
    });
    try { expect(await storage.readTitle(conversation, context)).toBe("latest CLI title"); }
    finally { validation.mockRestore(); vi.mocked(f.source.allowsBinding).mockRestore(); }
    expect(await storage.readTitle(conversation, context)).toBe("latest CLI title");
    expect(await storage.readFirstPrompt(conversation, context)).toBe("first prompt");
  });

  it("never turns custom attachment metadata or a later user into the first image-only user's title", async () => {
    const f = await fixture();
    const writer = openNativeSessionManager(f.source, f.binding);
    writer.manager.appendCustomMessageEntry("attachment", "附件（1 个）", true);
    writer.manager.appendMessage({ role: "user", content: [{ type: "image", data: "fixture", mimeType: "image/png" }], timestamp: 1 });
    writer.manager.appendMessage({ role: "user", content: "later user", timestamp: 2 });
    writer.descriptor.close();
    const storage = new NativePiConversationStorage(f.source, { binding: async () => f.binding, claim: async () => null });
    const conversation = { agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file };
    expect(await storage.readTitle(conversation, { sessionId: "server", projectId: "project" })).toBeNull();
    expect(await storage.readFirstPrompt(conversation, { sessionId: "server", projectId: "project" })).toBe("");
  });

  it("bounds only first-prompt metadata to 512 characters, not exported user content", async () => {
    const f = await fixture();
    const writer = openNativeSessionManager(f.source, f.binding);
    const prompt = "x".repeat(60_000);
    writer.manager.appendCustomMessageEntry("attachment", "not the first user", true);
    writer.manager.appendMessage({ role: "user", content: prompt, timestamp: 1 });
    writer.descriptor.close();
    const storage = new NativePiConversationStorage(f.source, { binding: async () => f.binding, claim: async () => null });
    const conversation = { agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file };
    const context = { sessionId: "server", projectId: "project" };
    expect(await storage.readFirstPrompt(conversation, context)).toBe(prompt.slice(0, 512));
    const exported = await storage.readExport(conversation, context);
    expect(exported.messages.find(m => m.role === "user")?.text).toBe(prompt);
  });

  it.each(["jsonl", "utf8"])("keeps %s truncated suffix unknown and expires its negative cache", async mode => {
    const f = await fixture();
    const writer = openNativeSessionManager(f.source, f.binding);
    writer.manager.appendMessage({ role: "user", content: "first real user", timestamp: 1 });
    writer.manager.appendSessionInfo("older name");
    writer.descriptor.close();
    const incomplete = mode === "jsonl" ? Buffer.from('{"type":"session_info","name":"unfinished') : Buffer.from([0xe4, 0xb8]);
    appendFileSync(f.file, incomplete);
    const storage = new NativePiConversationStorage(f.source, { binding: async () => f.binding, claim: async () => null });
    const conversation = { agentKind: "pi", conversationFormat: "pi-native-jsonl-v3", conversationRef: f.file };
    const context = { sessionId: "server", projectId: "project" };
    const range = vi.spyOn(NativeSessionFd.prototype, "readRange");
    let now = 100_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect(await storage.readTitle(conversation, context)).toBeNull();
      expect(await storage.readFirstPrompt(conversation, context)).toBe("first real user");
      const cold = range.mock.calls.length;
      now += 1999;
      expect(await storage.readTitle(conversation, context)).toBeNull();
      expect(range).toHaveBeenCalledTimes(cold);
      now += 2;
      expect(await storage.readTitle(conversation, context)).toBeNull();
      expect(range.mock.calls.length).toBeGreaterThan(cold);
    } finally { clock.mockRestore(); range.mockRestore(); }
  });

  it("provides verified raw bytes, encoded relative path and identity metadata for future archive integration", async () => {
    const f = await fixture(); const snapshot = readNativeSourceSnapshot(f.source, f.binding);
    expect(snapshot.bytes).toEqual(Buffer.from(f.header));
    expect(snapshot.relativeSourcePath).toBe(path.join(nativeProjectDirectory(f.cwd), "pi.jsonl"));
    expect(snapshot.metadata).toMatchObject({ sourceId: "pi-id", cwd: f.cwd, sourceDev: f.binding.sourceDev, sourceIno: f.binding.sourceIno, size: Buffer.byteLength(f.header), nlink: 1 });
    expect(() => readNativeSourceSnapshot(f.source, f.binding, 1)).toThrow("budget exceeded");
  });

  it("high-frequency output checks only metadata, never transcript reads/writes", async () => {
    const f = await fixture(true); const fd = new NativeSessionFd(f.source, f.binding, true); io.reads = 0;
    const start = performance.now();
    for (let i = 0; i < 2000; i++) fd.check();
    console.info(`native FD output checks: 2000 in ${(performance.now() - start).toFixed(1)}ms; JSONL reads=${io.reads}, writes=${io.writes}`);
    expect(io.reads).toBe(0); expect(io.writes).toBe(0); fd.close();
  });
});
