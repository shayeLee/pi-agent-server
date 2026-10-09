import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../src/server/app.js";
import { PiJsonlConversationStorage, readPiJsonlFirstPrompt, FIRST_PROMPT_MAX_BYTES, FIRST_PROMPT_MAX_LINE_BYTES, FIRST_PROMPT_MAX_LINES } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";
import { resolveSessionDisplayTitle, firstUserPrompt } from "../../src/client/session-title.js";

const prompt = `首条多行\n${"完整长提示词".repeat(150)}`;
function transcript(text: string) {
  return [JSON.stringify({ type: "session", version: 3, id: "fixture" }),
    JSON.stringify({ type: "message", id: "first", parentId: null, message: { role: "user", content: [{ type: "text", text }] } }),
    JSON.stringify({ type: "message", id: "later", parentId: "first", message: { role: "user", content: "不替换首条" } }), ""].join("\n");
}

describe("display title / history summaries", () => {
  it("preserves full text, explicit literal title and first image-only message", () => {
    expect(resolveSessionDisplayTitle({ title: "", firstPrompt: prompt })).toBe(prompt);
    expect(resolveSessionDisplayTitle({ title: "未命名会话", firstPrompt: prompt })).toBe("未命名会话");
    expect(resolveSessionDisplayTitle({ title: "自定义", firstPrompt: prompt })).toBe("自定义");
    expect(firstUserPrompt([{ role: "user", content: [{ type: "image" }] }, { role: "user", text: "later" }])).toBe("");
    expect(resolveSessionDisplayTitle({ title: "", firstPrompt: " \n " })).toBe("未命名会话");
  });

  it("lists old unselected sessions without export/runtime/write; survives app restart and rename", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-title-test-"));
    const db = await makeInitializedMemoryDb({ dataDir: root });
    const reader = new PiJsonlConversationStorage(root);
    const registry = new ConversationStorageRegistry(); registry.register(reader);
    const exportSpy = vi.spyOn(reader, "readExport");
    const createAdapter = vi.fn(async () => { throw new Error("must not instantiate"); });
    const ownerKey = identityKey({ kind: "ip", ip: "10.0.0.1" });
    const files: string[] = [];
    for (const [id, title, text] of [["old", "", prompt], ["image", "", ""], ["named", "未命名会话", prompt], ["foreign", "", "PRIVATE"]]) {
      const dir = path.join(root, "sessions", id!); mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "fixture.jsonl"); writeFileSync(file, transcript(text!)); files.push(file);
      await db.sessions.create({ id: id!, title: title!, ownerKey: id === "foreign" ? "foreign-owner" : ownerKey,
        projectId: DEFAULT_PROJECT_ID, createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: file,
        modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
    }
    const before = files.map((file) => readFileSync(file, "utf8"));
    const makeApp = () => buildApp({ sessions: db.sessions, projects: db.projects, defaultProjectCwd: root,
      ipAccess: makeTestIpAccess(), conversationStorage: registry, createAdapter });
    let app = makeApp();
    try {
      const list = async () => (await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: "10.0.0.1" })).json();
      let rows = await list();
      expect(rows).toHaveLength(3);
      expect(rows.find((row: { id: string }) => row.id === "old")).toMatchObject({ title: "", firstPrompt: prompt });
      expect(rows.find((row: { id: string }) => row.id === "image")).toMatchObject({ title: "", firstPrompt: "" });
      expect(rows.find((row: { id: string }) => row.id === "named")).not.toHaveProperty("firstPrompt");
      await app.close(); app = makeApp();
      rows = await list(); expect(rows.find((row: { id: string }) => row.id === "old").firstPrompt).toBe(prompt);
      await db.sessions.update("old", { title: "用户标题" });
      await db.sessions.updateTitleIfEmpty(ownerKey, "old", "乱序自动标题", 2);
      expect((await list()).find((row: { id: string }) => row.id === "old").title).toBe("用户标题");
      expect(createAdapter).not.toHaveBeenCalled(); expect(exportSpy).not.toHaveBeenCalled();
      expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
      expect((await db.sessions.get("image"))?.title).toBe("");
    } finally { await app.close(); await db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds bytes, lines and oversized lines before a later user", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-title-budget-"));
    const file = path.join(root, "fixture.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "fixture" }) + "\n";
    const nonUser = JSON.stringify({ type: "custom", id: "x", parentId: null, data: "x".repeat(4096) }) + "\n";
    try {
      for (const prefix of [" ".repeat(FIRST_PROMPT_MAX_LINE_BYTES + 1) + "\n", "\n".repeat(FIRST_PROMPT_MAX_LINES), nonUser.repeat(Math.ceil(FIRST_PROMPT_MAX_BYTES / nonUser.length))]) {
        writeFileSync(file, header + prefix + transcript("must not guess"));
        expect(await readPiJsonlFirstPrompt(file)).toBeNull();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects cross-session leaf/ancestor symlinks, including cached summaries", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-title-symlink-"));
    const ownDir = path.join(root, "sessions", "own");
    const foreignDir = path.join(root, "sessions", "foreign");
    mkdirSync(ownDir, { recursive: true }); mkdirSync(foreignDir, { recursive: true });
    const own = path.join(ownDir, "fixture.jsonl"); const foreign = path.join(foreignDir, "fixture.jsonl");
    const storage = new PiJsonlConversationStorage(root);
    const read = () => storage.readFirstPrompt({ agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: own }, { sessionId: "own", projectId: DEFAULT_PROJECT_ID });
    try {
      writeFileSync(own, transcript("own prompt")); writeFileSync(foreign, transcript("PRIVATE FOREIGN"));
      expect(await read()).toBe("own prompt");
      rmSync(own); symlinkSync(foreign, own);
      expect(await read()).toBeNull();
      rmSync(ownDir, { recursive: true }); symlinkSync(foreignDir, ownDir);
      expect(await read()).toBeNull();
      expect(await storage.readFirstPrompt({ agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: foreign }, { sessionId: "own", projectId: DEFAULT_PROJECT_ID })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("invalidates a negative cache after file metadata changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-title-negative-"));
    const dir = path.join(root, "sessions", "own"); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "fixture.jsonl"); const storage = new PiJsonlConversationStorage(root);
    const read = () => storage.readFirstPrompt({ agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: file }, { sessionId: "own", projectId: DEFAULT_PROJECT_ID });
    try {
      writeFileSync(file, "malformed\n"); expect(await read()).toBeNull();
      expect(await read()).toBeNull();
      writeFileSync(file, transcript(prompt)); expect(await read()).toBe(prompt);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prefix reader stops at first user; empty/missing/malformed history is unavailable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-title-prefix-")); const file = path.join(root, "fixture.jsonl");
    try {
      writeFileSync(file, transcript(prompt) + "malformed later data\n");
      expect(await readPiJsonlFirstPrompt(file)).toBe(prompt);
      writeFileSync(file, ""); expect(await readPiJsonlFirstPrompt(file)).toBeNull();
      writeFileSync(file, "not json\n"); expect(await readPiJsonlFirstPrompt(file)).toBeNull();
      expect(await readPiJsonlFirstPrompt(path.join(root, "missing"))).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
