// Pi JSONL 只读会话历史解析（生产实现 PiJsonlConversationStorage）：
// - 真实 SDK JSONL fixture（SessionManager 真实写入）→ 只读解析 → 与 PiAgentAdapter 同一投影；
// - 零写验证：读取前后文件 stat+sha256 逐字节一致；
// - 错误脱敏：缺失/损坏/被篡改文件只抛固定文案，不含路径/内容；空文件 = 新会话空导出。
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readPiJsonlExport } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";

function makeSessionDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-history-reader-"));
}

/** 用真实 SDK 生成生产形态的 JSONL 会话文件（user/assistant/toolResult + text/thinking 块）。 */
function makeFixtureSession(dir: string): { file: string; manager: SessionManager } {
  const manager = SessionManager.create("/tmp/project", dir);
  // appendMessage 的 SDK 类型要求完整 Message（含 timestamp/toolResult 字段）；fixture 用
  // 与 JSONL 实际结构一致的宽松形态（appendMessage 内部即按此序列化，运行时无校验差异）。
  type AppendArg = Parameters<SessionManager["appendMessage"]>[0];
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "你好" }] } as unknown as AppendArg);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "回复" }, { type: "thinking", text: "内部思考" }],
  } as unknown as AppendArg);
  manager.appendMessage({ role: "toolResult", content: [{ type: "text", text: "工具结果" }] } as unknown as AppendArg);
  const file = manager.getSessionFile();
  if (!file) throw new Error("fixture session file missing");
  return { file, manager };
}

/** 文件零写指纹（stat + sha256）。 */
function fingerprint(file: string): string {
  const st = statSync(file);
  return JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
}

describe("PiJsonlConversationStorage（只读导出解析）", () => {
  it("只读解析真实 JSONL，投影与 PiAgentAdapter.exportSession 完全一致（role/text，忽略 thinking/toolResult）", async () => {
    const dir = makeSessionDir();
    const { file, manager } = makeFixtureSession(dir);
    const exported = (await readPiJsonlExport(file)) as Array<{ role: string; text: string }>;

    // 只保留 user/assistant 并提取 text 块；thinking 与 toolResult 一律忽略。
    expect(exported).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", text: "回复" },
    ]);

    // 与活会话导出（PiAgentAdapter）逐字节一致：同一 messages（buildSessionContext 构造，
    // 即 AgentSession.messages 的同类结构）经同一投影函数得到相同结果。
    const live = new PiAgentAdapter({
      messages: manager.buildSessionContext().messages as unknown[],
    } as unknown as AgentSessionLike);
    expect(await live.exportSession()).toEqual(exported);
  });

  it("零写：读取后文件 stat + sha256 指纹逐字节不变", async () => {
    const dir = makeSessionDir();
    const { file } = makeFixtureSession(dir);
    const before = fingerprint(file);
    await readPiJsonlExport(file);
    expect(fingerprint(file)).toBe(before);
  });

  it("空文件（新会话未写任何事件）：返回空消息列表且不写文件", async () => {
    const dir = makeSessionDir();
    const file = path.join(dir, "empty.jsonl");
    writeFileSync(file, "");
    const before = fingerprint(file);
    const exported = await readPiJsonlExport(file);
    expect(exported).toEqual([]);
    expect(fingerprint(file)).toBe(before);
  });

  it("rejects a legacy v1/v2 history without SDK migration and leaves its bytes unchanged", async () => {
    const dir = makeSessionDir();
    for (const [name, version] of [["v1", undefined], ["v2", 2]] as const) {
      const file = path.join(dir, `${name}.jsonl`);
      const header = version === undefined
        ? '{"type":"session","id":"legacy","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp/project"}'
        : `{"type":"session","version":${version},"id":"legacy","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp/project"}`;
      writeFileSync(file, `${header}\n{"type":"message","message":{"role":"user","content":"legacy"}}\n`);
      const before = fingerprint(file);
      await expect(readPiJsonlExport(file)).rejects.toThrow("会话历史读取失败");
      expect(fingerprint(file)).toBe(before);
    }
  });

  it("缺失文件：脱敏错误（不含文件路径/内容）", async () => {
    const dir = makeSessionDir();
    try {
      await readPiJsonlExport(path.join(dir, "no-such.jsonl"));
      expect.unreachable("应当抛错");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("会话历史读取失败");
      expect(message).not.toContain(dir);
      expect(message).not.toContain("no-such.jsonl");
    }
  });

  it("rejects a v3 header carrying a malformed line without SDK migration and leaves its bytes unchanged", async () => {
    const dir = makeSessionDir();
    const file = path.join(dir, "v3-badline.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"sess","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}',
      "{\"broken\":",
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      "",
    ].join("\n"));
    const before = fingerprint(file);
    await expect(readPiJsonlExport(file)).rejects.toThrow("会话历史读取失败");
    expect(fingerprint(file)).toBe(before);
  });

  it("rejects a non-Pi file (no session header) without SDK migration and leaves its bytes unchanged", async () => {
    const dir = makeSessionDir();
    const file = path.join(dir, "non-pi.jsonl");
    writeFileSync(file, '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n');
    const before = fingerprint(file);
    await expect(readPiJsonlExport(file)).rejects.toThrow("会话历史读取失败");
    expect(fingerprint(file)).toBe(before);
  });

  it("损坏文件（非空且零可解析条目）：脱敏错误，文件保持原位不变", async () => {
    const dir = makeSessionDir();
    const file = path.join(dir, "corrupt.jsonl");
    writeFileSync(file, "this is not json\n{\"broken\":\n");
    const before = fingerprint(file);
    try {
      await readPiJsonlExport(file);
      expect.unreachable("应当抛错");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("会话历史读取失败");
      expect(message).not.toContain(dir);
      expect(message).not.toContain("broken");
    }
    expect(fingerprint(file)).toBe(before);
  });
});