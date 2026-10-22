import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeSessionPolicy, canonicalCwdIdentity, liveCwdIdentity, resolveNativeSessionSourceDir, sameSavedCwdIdentity, splitSessionExcludeCwds } from "../../src/core/native-session-policy.js";
import { NativeSessionSource, nativeProjectDirectory, NATIVE_HEADER_MAX_BYTES, NATIVE_SCAN_MAX_ENTRIES } from "../../src/agent/native-session-source.js";
import { openPiRuntimeSessionFile } from "../../src/agent/pi-jsonl-conversation-storage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-source-"))); roots.push(root);
  const cwd = path.join(root, "project"); mkdirSync(cwd);
  const sessions = path.join(root, "sessions"); mkdirSync(sessions);
  const directory = path.join(sessions, nativeProjectDirectory(cwd)); mkdirSync(directory);
  const identity = canonicalCwdIdentity(cwd);
  const source = new NativeSessionSource(sessions, new NativeSessionPolicy([]));
  const file = (name: string, overrides: object = {}) => {
    const target = path.join(directory, `${name}.jsonl`);
    writeFileSync(target, JSON.stringify({ type: "session", version: 3, id: name, cwd, timestamp: new Date(0).toISOString(), ...overrides }) + "\n");
    return target;
  };
  return { root, cwd, sessions, directory, identity, source, file };
}

describe("native source and exclusion policy", () => {
  it("resolves CLI agent-dir independently from DATA_DIR and PI_AGENT_DIR without reading home", () => {
    expect(resolveNativeSessionSourceDir({ home: "/fixture-home", env: { DATA_DIR: "/db", PI_AGENT_DIR: "/server" } })).toBe("/fixture-home/.pi/agent/sessions");
    expect(resolveNativeSessionSourceDir({ home: "/fixture-home", env: { PI_CODING_AGENT_DIR: "~/cli" } })).toBe("/fixture-home/cli/sessions");
    expect(resolveNativeSessionSourceDir({ home: "/fixture-home", env: {}, sourceDir: "/sources" })).toBe("/sources");
    expect(splitSessionExcludeCwds(" , /one, /two ,, ")).toEqual(["/one", "/two"]);
  });

  it("exact canonical exclusions deduplicate aliases; missing exclusions fail closed even after startup", () => {
    const f = fixture(); const alias = path.join(f.root, "alias"); symlinkSync(f.cwd, alias);
    const policy = new NativeSessionPolicy([alias]);
    expect(policy.allows(f.identity)).toBe(false);
    const child = path.join(f.cwd, "child"); mkdirSync(child);
    expect(policy.allows(canonicalCwdIdentity(child))).toBe(true);
    expect(() => new NativeSessionPolicy([path.join(f.root, "missing")])).toThrow("configuration unavailable");
    rmSync(alias); expect(policy.allows(canonicalCwdIdentity(child))).toBe(false);
  });

  it("saved directory identities ignore dev but not path or inode", () => {
    const f = fixture();
    const saved = { ...f.identity, dev: f.identity.dev + 2 };
    expect(sameSavedCwdIdentity(saved, f.identity)).toBe(true);
    expect(sameSavedCwdIdentity({ ...saved, ino: saved.ino + 1 }, f.identity)).toBe(false);
    expect(sameSavedCwdIdentity({ ...saved, cwd: f.root }, f.identity)).toBe(false);
    expect(new NativeSessionPolicy([]).allows(saved)).toBe(true);
    expect(liveCwdIdentity(saved)).toEqual(f.identity);
    rmSync(f.cwd, { recursive: true }); mkdirSync(f.cwd);
    expect(liveCwdIdentity(saved)).toBeNull();
    expect(new NativeSessionPolicy([]).allows(saved)).toBe(false);
  });

  it("pages are bounded by examined entries and expose only fixed warnings", async () => {
    const f = fixture(); for (let i = 0; i < 7; i++) f.file(`s${i}`);
    let offset: number | null = 0; const ids: string[] = [];
    while (offset !== null) {
      const page = await f.source.scan(f.identity, offset, 2);
      expect(page.sources.length).toBeLessThanOrEqual(2);
      ids.push(...page.sources.map(value => value.binding.sourceId)); offset = page.nextOffset;
    }
    expect(new Set(ids).size).toBe(7);
    await expect(f.source.scan(f.identity, -1)).rejects.toThrow("invalid native scan page");
  });

  it("caps total traversal and reports truncation rather than claiming a complete scan", async () => {
    const f = fixture();
    for (let i = 0; i <= NATIVE_SCAN_MAX_ENTRIES; i++) f.file(`bounded-${i}`);
    const page = await f.source.scan(f.identity, NATIVE_SCAN_MAX_ENTRIES - 10, 100);
    expect(page.sources).toHaveLength(10);
    expect(page.nextOffset).toBeNull();
    expect(page.warnings).toContain("native-scan-truncated");
  });

  it("skips v2, bad/oversized headers, cwd mismatch, symlinks and source-root escapes without rewriting", async () => {
    const f = fixture(); const legacy = f.file("old", { version: 2 }); const original = readFileSync(legacy);
    f.file("mismatch", { cwd: f.root }); f.file("good");
    writeFileSync(path.join(f.directory, "bad.jsonl"), "not-json\n");
    writeFileSync(path.join(f.directory, "huge.jsonl"), "x".repeat(NATIVE_HEADER_MAX_BYTES + 10));
    symlinkSync(legacy, path.join(f.directory, "link.jsonl"));
    const scan = await f.source.scan(f.identity);
    expect(scan.sources.map(value => value.binding.sourceId)).toEqual(["good"]);
    expect(scan.warnings).toEqual(["native-source-skipped"]);
    expect(readFileSync(legacy)).toEqual(original);
    const binding = scan.sources[0]!.binding;
    expect(() => f.source.validate({ ...binding, sourcePath: legacy })).toThrow();
    expect(() => f.source.validate({ ...binding, sourcePath: path.join(f.root, "escape.jsonl") })).toThrow();
    const linkedRoot = path.join(f.root, "linked-sessions"); symlinkSync(f.sessions, linkedRoot);
    expect((await new NativeSessionSource(linkedRoot, new NativeSessionPolicy([])).scan(f.identity)).sources).toEqual([]);
  });

  it("validated v3 manager continues original path/header ID and appends; v2 stays unchanged", async () => {
    const f = fixture(); const file = f.file("original-pi-id");
    const before = readFileSync(file, "utf8");
    const binding = (await f.source.scan(f.identity)).sources[0]!.binding;
    f.source.validate(binding);
    const manager = openPiRuntimeSessionFile(file);
    expect(manager.getSessionFile()).toBe(file);
    expect(manager.getSessionId()).toBe("original-pi-id");
    manager.appendMessage({ role: "user", content: "continue", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-responses", provider: "fake", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
    expect(readFileSync(file, "utf8").startsWith(before)).toBe(true);
    f.source.validate(binding);
    const legacy = f.file("legacy", { version: 2 }); const bytes = readFileSync(legacy);
    expect(() => openPiRuntimeSessionFile(legacy)).toThrow(); expect(readFileSync(legacy)).toEqual(bytes);
  });
});
