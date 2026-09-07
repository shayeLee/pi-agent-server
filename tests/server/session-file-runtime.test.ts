// WP5D-3 P1 runtime session-file boundary: openPiRuntimeSessionFile strictly
// rejects non-Pi JSONL v3 (empty, malformed lines, old version, non-Pi) and
// never hands the replaceable original path to the auto-migrating/writing
// SessionManager.open.  Instead it reads+validates the content once and builds
// a persisted SessionManager from the validated in-memory v3 entries, so the
// SDK never reads/writes the original file during open (no empty→header,
// no v1/v2→v3, no trailing-newline append).
//
// Production path (start.ts createAdapter) calls this for a persisted
// conversationRef.  This file exercises that helper directly with the real SDK
// (no model/network) to pin the fail-closed contract and prove that a
// check→construct race replacement to v1/v2/empty leaves the replaced file
// bytes untouched.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { openPiRuntimeSessionFile } from "../../src/agent/pi-jsonl-conversation-storage.js";

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-runtime-file-"));
}

function fingerprint(file: string): string {
  const st = statSync(file);
  return JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
}

const V3_HEADER = '{"type":"session","version":3,"id":"sess-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}';
const MESSAGE_LINE = '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';

/** 以每行一个 JSON 条目写入会话文件（末尾带换行，与 pi 实际写出格式一致）。 */
function writeNewlineTerminated(file: string, lines: string[]): void {
  writeFileSync(file, lines.join("\n") + "\n");
}

describe("openPiRuntimeSessionFile（WP5D-3 P1 runtime：SessionManager.open 前严格拒绝 + 替换竞态防护）", () => {
  it("接受当前 Pi JSONL v3，且 open 不改动文件（无隐式重写/迁移），历史被正确加载", () => {
    const dir = makeDir();
    const file = path.join(dir, "current.jsonl");
    writeNewlineTerminated(file, [V3_HEADER, MESSAGE_LINE]);
    const before = fingerprint(file);
    const manager = openPiRuntimeSessionFile(file);
    expect(manager.getSessionFile()).toBe(file);
    expect(manager.getSessionId()).toBe("sess-1");
    expect(manager.getEntries().length).toBe(1);
    expect(fingerprint(file)).toBe(before);
  });

  it("合法 v3 打开后仍可正常追加并持久化到原路径（运行行为保持，绝非临时副本）", () => {
    const dir = makeDir();
    const file = path.join(dir, "persist.jsonl");
    writeNewlineTerminated(file, [V3_HEADER, MESSAGE_LINE]);
    const manager = openPiRuntimeSessionFile(file);
    // 追加一条 thinking_level_change：应写入被打开的原文件（而非任何安全临时副本）。
    manager.appendThinkingLevelChange("medium");
    const written = readFileSync(file, "utf8");
    expect(written).toContain('"thinking_level_change"');
    // 追加后仍是以换行结尾的合法 JSONL（每行一个对象）。
    expect(written.endsWith("\n")).toBe(true);
  });

  it("拒绝空文件（运行期打开会导致 SDK 隐式写入 session header），文件保持原位不变", () => {
    const dir = makeDir();
    const file = path.join(dir, "empty.jsonl");
    writeFileSync(file, "");
    const before = fingerprint(file);
    expect(() => openPiRuntimeSessionFile(file)).toThrow("session history is empty");
    expect(fingerprint(file)).toBe(before);
  });

  it("拒绝包含坏行（非合法 JSON）的 v3 文件，绝不让 SDK 静默跳过", () => {
    const dir = makeDir();
    const file = path.join(dir, "badline.jsonl");
    writeFileSync(file, `${V3_HEADER}\n{"broken":\n${MESSAGE_LINE}\n`);
    const before = fingerprint(file);
    expect(() => openPiRuntimeSessionFile(file)).toThrow("session history contains a malformed line");
    expect(fingerprint(file)).toBe(before);
  });

  it("拒绝旧版本（v1 缺版本号 / v2），文件保持原位不变", () => {
    const dir = makeDir();
    for (const [name, header] of [
      ["v1", '{"type":"session","id":"legacy","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}'],
      ["v2", '{"type":"session","version":2,"id":"legacy","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}'],
    ] as const) {
      const file = path.join(dir, `${name}.jsonl`);
      writeFileSync(file, `${header}\n${MESSAGE_LINE}\n`);
      const before = fingerprint(file);
      expect(() => openPiRuntimeSessionFile(file)).toThrow("session history is not Pi JSONL v3");
      expect(fingerprint(file)).toBe(before);
    }
  });

  it("拒绝非 Pi 文件（首条不是 session 头 / 无 session 头 / 数组 / 仅空白），文件保持原位不变", () => {
    const dir = makeDir();
    const cases: Array<{ name: string; content: string; message: string }> = [
      // 首条是普通消息条目（非 session 头）
      { name: "non-session-first", content: `${MESSAGE_LINE}\n`, message: "session history is not Pi JSONL v3" },
      // 首条是数组（非对象）
      { name: "array-first", content: "[]\n", message: "session history contains a malformed entry" },
      // 只有空白（运行期视同空文件）
      { name: "whitespace-only", content: "   \n", message: "session history is empty" },
    ];
    for (const item of cases) {
      const file = path.join(dir, `${item.name}.jsonl`);
      writeFileSync(file, item.content);
      const before = fingerprint(file);
      expect(() => openPiRuntimeSessionFile(file)).toThrow(item.message);
      expect(fingerprint(file)).toBe(before);
    }
  });

  it("拒绝末行无换行的非规范 v3 副本（SDK 写出格式须以换行结尾），文件保持原位不变", () => {
    const dir = makeDir();
    // SDK 写出的 v3 文件恒以换行结尾；缺末行换行不是规范副本。旧实现靠检测 SDK 在 open 时
    // 补写换行（对源文件写入）而 fail-closed；新实现直接在校验期拒绝，绝不触发任何对源文件的写入。
    const file = path.join(dir, "no-trailing-newline.jsonl");
    writeFileSync(file, `${V3_HEADER}\n${MESSAGE_LINE}`);
    const before = fingerprint(file);
    expect(() => openPiRuntimeSessionFile(file)).toThrow("session history is not Pi JSONL v3");
    expect(fingerprint(file)).toBe(before);
  });

  it("校验读取后、构造前文件被替换为 v1/v2/empty：替换文件字节不变，且 fail-closed（SDK 绝不改写原路径）", () => {
    const dir = makeDir();
    const replacements = [
      { name: "v1", content: '{"type":"session","id":"legacy","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}\n' },
      { name: "v2", content: '{"type":"session","version":2,"id":"legacy","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}\n' },
      { name: "empty", content: "" },
    ] as const;
    for (const { name, content } of replacements) {
      const file = path.join(dir, `race-${name}.jsonl`);
      // 合法 v3（带规范换行），预检将通过。
      writeNewlineTerminated(file, [V3_HEADER, MESSAGE_LINE]);
      let swapDone = false;
      // 在「校验通过、SDK 构造前」注入竞态：把原路径替换为 v1/v2/empty。
      expect(() =>
        openPiRuntimeSessionFile(file, {
          onContentValidated: () => {
            swapDone = true;
            writeFileSync(file, content);
          },
        }),
      ).toThrow("会话文件在打开期间被修改（拒绝 SDK 隐式迁移/重写）");
      expect(swapDone).toBe(true);
      // 核心断言：替换进来的 v1/v2/empty 原样保留——SDK 绝未改写原路径（旧实现会在
      // SessionManager.open 时把空/旧版改写为 v3）。
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });
});
