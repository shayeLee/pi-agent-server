import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createViewerData, presentationText } from "../src/ops-viewer/data.js";
import { createViewerServer } from "../src/ops-viewer/server.js";

const id = "e2d730cd-5231-4198-811c-fbe24a65aab9";
const project = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ops-viewer-")); dirs.push(root);
  const dbPath = path.join(root, "sessions.db");
  const folder = path.join(root, "sessions", id); mkdirSync(folder, { recursive: true });
  const assetsDir = path.join(root, "assets"); mkdirSync(assetsDir); writeFileSync(path.join(assetsDir, "index.html"), "<!doctype html><title>会话记录</title>");
  const file = path.join(folder, "test.jsonl");
  const lines = [
    { type: "session", version: 3, id: "pi-session", timestamp: "2026-09-24T00:00:00Z", cwd: root },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-09-24T00:00:01Z", message: { role: "user", content: [{ type: "text", text: '[ONEV_CONTEXT_V1]{"componentNames":[]}[/ONEV_CONTEXT_V1]\n\n开场问题' }], timestamp: 1 } },
    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-24T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "回答 <script>alert(1)</script>" }], timestamp: 2, api: "openai-completions", provider: "modelscope", model: "test", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: "message", id: "m3", parentId: "m2", timestamp: "2026-09-24T00:00:03Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 insufficient balance" } },
  ];
  writeFileSync(file, lines.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE sessions (id TEXT, owner_key TEXT, project_id TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, conversation_ref TEXT, system_prompt TEXT, agent_kind TEXT, conversation_format TEXT)");
  const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pi', 'pi-jsonl-v3')");
  insert.run(id, "ip:192.168.6.23", project, "问题", 10, 20, file, "# 系统提示词\n**仅运维可见**");
  insert.run("00000000-0000-0000-0000-000000000001", "ip:192.168.8.223", project, "另一个问题", 10, 30, null, null);
  db.close();
  return { root, dbPath, assetsDir };
}

describe("read-only cross-IP ops viewer", () => {
  it("lists IPs, projects only chat text, strips control envelopes and ignores empty error messages", async () => {
    const { root, dbPath } = fixture();
    const data = createViewerData(dbPath, root);
    try {
      expect(data.listIps()).toEqual([{ ip: "192.168.6.23", count: 1 }, { ip: "192.168.8.223", count: 1 }]);
      expect(data.listSessions("192.168.6.23", 0).sessions[0]?.id).toBe(id);
      expect(data.listSessions("not-an-ip", 0).total).toBe(0);
      expect((await data.getSession(id))?.systemPrompt).toBe("# 系统提示词\n**仅运维可见**");
      expect((await data.getSession(id))?.messages).toEqual([
        { role: "user", text: "开场问题" }, { role: "assistant", text: "回答 <script>alert(1)</script>" },
      ]);
      expect(await data.getSession("missing")).toBeNull();
    } finally { data.close(); }
  });

  it("does not interpret an incomplete envelope as control data", () => {
    expect(presentationText("[ONEV_CONTEXT_V1]unclosed 用户文字")).toBe("[ONEV_CONTEXT_V1]unclosed 用户文字");
  });

  it("serves a read-only UI and frozen system prompt with no-cache and strict CSP", async () => {
    const { root, dbPath, assetsDir } = fixture();
    const data = createViewerData(dbPath, root), server = createViewerServer(data, assetsDir);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
      const base = `http://127.0.0.1:${address.port}`;
      const html = await fetch(base);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(await html.text()).toContain("会话记录");
      const ips = await fetch(base + "/api/ips");
      expect(ips.headers.get("cache-control")).toBe("no-store");
      expect((await ips.json() as { ips: unknown[] }).ips).toHaveLength(2);
      expect((await fetch(base + "/api/sessions?ip=192.168.6.23")).status).toBe(200);
      const details = await fetch(base + "/api/sessions/" + id);
      expect(details.status).toBe(200);
      expect((await details.json() as { systemPrompt: string }).systemPrompt).toContain("系统提示词");
      expect((await fetch(base + "/api/sessions/" + id, { method: "POST" })).status).toBe(405);
      expect((await fetch(base + "/api/sessions?ip=x&offset=-1")).status).toBe(400);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); data.close(); }
  });
});
