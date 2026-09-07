// WP4C（方案 A 收敛）安全 DB-only reconcile analyzer 核心测试：
// - 纯字符串/lexical 分类矩阵：default project → sessions/<sessionId>/<file>（3 段）、
//   other project → projects/<projectId>/sessions/<sessionId>/<file>（5 段），
//   **固定 literal 段逐字校验**（同段数伪目录 sessions2/、Projects/、project/、
//   foo/ 一律拒绝）；null = normal unmaterialized（计数非 issue）；id mismatch /
//   错误 DATA_DIR 前缀 / parsed root 与 DATA_DIR 不一致（跨卷/伪 root）/ NUL /
//   UNC / traversal / 空 / 非法 file name → invalid_reference；
// - 重复检测按 canonical 分组、**owner 优先且与输入/ID 顺序无关**：完全匹配
//   layout 身份的成员是 owner（valid），无 owner 的组全部 id mismatch → invalid；
// - DATA_DIR 纯字符串契约：显式、绝对、非 root、无 NUL、非 UNC、无 traversal；
//   **不要求存在、不做 realpath**（测试全程不创建任何文件/目录）；
// - 报告红action：只有 counts + 固定 issue codes + opaque sha256 引用，绝不含
//   任何路径/URL/session id/prompt 内容；filesystemNotScanned 明确声明，
//   cannotDetect（orphan/lost/jsonl validity）固定 false；可执行性恒为 false。

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RECONCILE_ISSUE_CODES,
  analyzeReconcileReferences,
  requireReconcileDataDir,
  ReconcileDataDirError,
  type ReconcileReport,
} from "../../src/file-operations/reconcile.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { ReconcileReferenceRecord } from "../../src/application/ports/reconcile-reference-port.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * dataDir 仅作为字符串参与绑定：用真实 tmp 绝对路径但不创建目录，证明分析
 * 不要求存在、不触碰文件系统。
 */
function dataDirFixture(): string {
  const dir = path.join(tmpdir(), `pi-reconcile-lexical-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  cleanups.push(dir);
  return dir;
}

function ref(sessionId: string, conversationRef: string | null, projectId = DEFAULT_PROJECT_ID): ReconcileReferenceRecord {
  return { sessionId, projectId, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef };
}

function hashSession(sessionId: string): string {
  return createHash("sha256").update(`session\u0000${sessionId}`, "utf8").digest("hex");
}

const OTHER_PROJECT = "11111111-2222-4333-8444-555555555555";

describe("WP4C DB-only analyzer：规范布局分类与去重", () => {
  it("default project 布局 / other project 布局 / null unmaterialized 三分类", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("s1", path.join(dataDir, "sessions", "s1", "2025-01-01T00-00-00_s1.jsonl")), // default 合法
      ref("s2", path.join(dataDir, "projects", OTHER_PROJECT, "sessions", "s2", "2025-01-01T00-00-00_s2.jsonl"), OTHER_PROJECT), // other 合法
      ref("s3", null), // 懒会话未创建 → normal unmaterialized
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.status).toBe("analyzed");
    expect(report.mode).toBe("dry-run");
    expect(report.executable).toBe(false);
    expect(report.filesystemNotScanned).toBe(true);
    expect(report.cannotDetect).toEqual({ orphanFile: false, lostFile: false, jsonlValidity: false });
    expect(report.references).toBe(3);
    expect(report.unmaterialized).toBe(1);
    expect(report.valid).toBe(2);
    expect(report.invalidReferences).toBe(0);
    expect(report.duplicateReferences).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("null 是 normal unmaterialized：计数但绝不产生 issue（报告无任何 issue 组）", async () => {
    const dataDir = dataDirFixture();
    const report = await analyzeReconcileReferences(dataDir, [ref("lazy", null)]);
    expect(report.unmaterialized).toBe(1);
    expect(report.valid).toBe(0);
    expect(report.invalidReferences).toBe(0);
    expect(report.duplicateReferences).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("id mismatch：路径中的 session id / project id 与 DB 行不一致 → invalid_reference", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("s1", path.join(dataDir, "sessions", "s-other", "x_s-other.jsonl")), // session 段 ≠ DB id
      ref("s2", path.join(dataDir, "projects", "p-other", "sessions", "s2", "x_s2.jsonl"), OTHER_PROJECT), // project 段 ≠ DB 行
      ref("s3", path.join(dataDir, "sessions", "s3", "x_s3.jsonl")), // 合法
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(1);
    expect(report.invalidReferences).toBe(2);
    const invalid = report.issues.find((issue) => issue.code === "invalid_reference")!;
    expect(invalid.count).toBe(2);
    expect(invalid.references).toEqual([hashSession("s1"), hashSession("s2")].sort());
  });

  it("错误 root：default project 引用 projects/ 布局、other project 引用 sessions/ 布局 → invalid", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("s1", path.join(dataDir, "projects", "p1", "sessions", "s1", "x_s1.jsonl")), // default 项目却在 projects 根下
      ref("s2", path.join(dataDir, "sessions", "s2", "x_s2.jsonl"), OTHER_PROJECT), // other 项目却在 sessions 根下
      ref("s3", path.join(dataDir, "nowhere", "x_s3.jsonl")), // 不在两个布局根下
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(0);
    expect(report.invalidReferences).toBe(3);
  });

  it("traversal / 空 / 非绝对 / 越界同事目录布局 / 非法 file name → invalid_reference", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("a", ""), // 空
      ref("b", "   "), // 空白
      ref("c", path.join(dataDir, "sessions", "c", "..", "escape.jsonl")), // .. 穿越
      ref("d", path.join(dataDir, "sessions", "d", "..", "..", "etc", "passwd")), // 越级穿越
      ref("e", "relative/sessions/e/x.jsonl"), // 非绝对
      ref("f", "/"), // root 自身
      ref("g", path.join(dataDir, "sessions", "g", "sub", "x_g.jsonl")), // file 上有子目录（越界布局）
      ref("h", path.join(dataDir, "sessions", "h", "no-extension")), // 非法 file name（非 .jsonl）
      ref("i", path.join(dataDir, "sessions", "i")), // 缺 file 段
      ref("j", path.join(dataDir, "sessions", "j", "x_j.jsonl")), // 唯一合法
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(1);
    expect(report.invalidReferences).toBe(9);
    const invalid = report.issues.find((issue) => issue.code === "invalid_reference")!;
    expect(invalid.references).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(hashSession).sort());
  });

  it("重复同一 canonical reference：owner（完全匹配 layout 身份）先行，其余成员一律 duplicate；无 owner 的组全部 invalid", async () => {
    const dataDir = dataDirFixture();
    // 组 1：s1 是 canonical 首现（idsMatch → valid），dup-a / dup-b 重复引用同一文件。
    const shared = path.join(dataDir, "sessions", "s1", "2025-01-01T00-00-00_s1.jsonl");
    // 组 2：x9a / x9b 都指向 sessions/s9 槽位（DB 中无 s9 会话 → 无 owner）：
    // 组内没有任何成员完全匹配 layout 身份 → 全部 invalid_reference（不产生 duplicate）。
    const orphanSlot = path.join(dataDir, "sessions", "s9", "2025-01-01T00-00-00_s9.jsonl");
    const references = [
      ref("s1", shared),
      ref("dup-a", shared),
      ref("dup-b", shared),
      ref("x9a", orphanSlot),
      ref("x9b", orphanSlot),
      ref("solo", path.join(dataDir, "sessions", "solo", "2025-01-01T00-00-00_solo.jsonl")),
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(2); // s1 + solo
    expect(report.duplicateReferences).toBe(2); // dup-a + dup-b（owner s1 的 surplus 引用）
    expect(report.invalidReferences).toBe(2); // x9a + x9b（无 owner 组：全部 id mismatch）
    const duplicate = report.issues.find((issue) => issue.code === "duplicate_reference")!;
    expect(duplicate.count).toBe(2);
    expect(duplicate.references).toEqual([hashSession("dup-a"), hashSession("dup-b")].sort());
    const invalid = report.issues.find((issue) => issue.code === "invalid_reference")!;
    expect(invalid.count).toBe(2);
    expect(invalid.references).toEqual([hashSession("x9a"), hashSession("x9b")].sort());
  });

  it("owner 优先且与输入/ID 顺序无关：反序输入下 owner 仍 valid、其余仍 duplicate；报告引用按 hash 升序", async () => {
    const dataDir = dataDirFixture();
    const shared = path.join(dataDir, "sessions", "s1", "2025-01-01T00-00-00_s1.jsonl");
    const ownerLast = [ref("dup-a", shared), ref("dup-b", shared), ref("s1", shared)]; // owner 最后出现
    const ownerFirst = [ref("s1", shared), ref("dup-a", shared), ref("dup-b", shared)]; // owner 最先出现
    const first = await analyzeReconcileReferences(dataDir, ownerLast);
    const second = await analyzeReconcileReferences(dataDir, ownerFirst);
    expect(first).toEqual(second); // 顺序无关：完全一致
    expect(first.valid).toBe(1); // 只认 owner（s1），不是"首现"
    expect(first.duplicateReferences).toBe(2);
    expect(first.invalidReferences).toBe(0);
    const duplicate = first.issues.find((issue) => issue.code === "duplicate_reference")!;
    // 引用（owner 之外的成员 hash）稳定且按 hash 升序输出。
    expect(duplicate.references).toEqual([hashSession("dup-a"), hashSession("dup-b")].sort());
    expect(duplicate.references).toEqual([...duplicate.references].sort());
  });

  it("无 owner 的 canonical 组与输入顺序无关：正反序输入均全部 invalid、零 duplicate", async () => {
    const dataDir = dataDirFixture();
    const orphanSlot = path.join(dataDir, "sessions", "s9", "2025-01-01T00-00-00_s9.jsonl");
    const ascending = [ref("xa", orphanSlot), ref("xb", orphanSlot), ref("xc", orphanSlot)];
    const descending = [ref("xc", orphanSlot), ref("xb", orphanSlot), ref("xa", orphanSlot)];
    const first = await analyzeReconcileReferences(dataDir, ascending);
    const second = await analyzeReconcileReferences(dataDir, descending);
    expect(first).toEqual(second);
    expect(first.valid).toBe(0);
    expect(first.duplicateReferences).toBe(0);
    expect(first.invalidReferences).toBe(3);
    const invalid = first.issues.find((issue) => issue.code === "invalid_reference")!;
    expect(invalid.references).toEqual([hashSession("xa"), hashSession("xb"), hashSession("xc")].sort());
  });

  it("固定 literal 段：同段数伪目录（sessions2/、Projects/、project/、foo/、非 sessions 根）全部 invalid", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("a", path.join(dataDir, "foo", "a", "x_a.jsonl")), // 3 段但 layout[0] ≠ sessions（伪目录）
      ref("b", path.join(dataDir, "sessions2", "b", "x_b.jsonl")), // 同段数伪目录 sessions2/
      ref("c", path.join(dataDir, "Projects", "c", "x_c.jsonl")), // 大小写伪目录 Projects/
      ref("d", path.join(dataDir, "session", "d", "x_d.jsonl")), // 单数伪目录 session/
      ref("e", path.join(dataDir, "projects", OTHER_PROJECT, "foo", "e", "x_e.jsonl"), OTHER_PROJECT), // 5 段但 layout[2] ≠ sessions
      ref("f", path.join(dataDir, "projects", OTHER_PROJECT, "sessions2", "f", "x_f.jsonl"), OTHER_PROJECT), // 伪目录 sessions2/
      ref("g", path.join(dataDir, "project", OTHER_PROJECT, "sessions", "g", "x_g.jsonl"), OTHER_PROJECT), // 伪目录 project/
      ref("h", path.join(dataDir, "sessions", "h", "x_h.jsonl")), // 唯一合法（default 3 段字面正确）
      ref("i", path.join(dataDir, "projects", OTHER_PROJECT, "sessions", "i", "x_i.jsonl"), OTHER_PROJECT), // 合法（other 5 段字面正确）
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(2);
    expect(report.invalidReferences).toBe(7);
    const invalid = report.issues.find((issue) => issue.code === "invalid_reference")!;
    expect(invalid.references).toEqual(["a", "b", "c", "d", "e", "f", "g"].map(hashSession).sort());
  });

  it("NUL / UNC / 跨卷（parsed root 与 DATA_DIR 不一致）/ Windows 盘符形态 → invalid", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("nul", `${path.join(dataDir, "sessions", "nul", "x_nul.jsonl").slice(0, -1)}\u0000.jsonl`), // 路径含 NUL
      ref("unc", path.join("//server/share", "sessions", "unc", "x_unc.jsonl")), // UNC // 前缀
      ref("unc2", `\\\\server\\share\\sessions\\unc2\\x_unc2.jsonl`), // UNC \\ 前缀（posix 上非绝对 → invalid）
      ref("win", "C:\\data\\sessions\\win\\x_win.jsonl"), // Windows 盘符（posix 上非绝对 → invalid）
      ref("vol", path.join("/VolumeB", "data", "sessions", "vol", "x_vol.jsonl")), // 不同卷前缀（parsed root 相同但 DATA_DIR 前缀不符）
      ref("ok", path.join(dataDir, "sessions", "ok", "x_ok.jsonl")), // 唯一合法
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(1);
    expect(report.invalidReferences).toBe(5);
    const invalid = report.issues.find((issue) => issue.code === "invalid_reference")!;
    expect(invalid.references).toEqual(["nul", "unc", "unc2", "win", "vol"].map(hashSession).sort());
    // DATA_DIR 自身：NUL / UNC / root 拒绝（稳定静态错误，不回显路径）。
    for (const attempt of [`/a/b\u0000c`, "//server/share/data", "/"]) {
      expect(() => requireReconcileDataDir(attempt)).toThrow(ReconcileDataDirError);
    }
  });

  it("file name 边界：空 stem（.jsonl）/ 大小写（.JSONL）/ 无后缀 / 子目录 → invalid", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("a", path.join(dataDir, "sessions", "a", ".jsonl")), // 空 stem
      ref("b", path.join(dataDir, "sessions", "b", "x.JSONL")), // 大小写不匹配
      ref("c", path.join(dataDir, "sessions", "c", "no-extension")), // 无后缀
      ref("d", path.join(dataDir, "sessions", "d", "sub", "x_d.jsonl")), // file 上有子目录（越界布局）
      ref("e", path.join(dataDir, "sessions", "e", "x_e.jsonl")), // 唯一合法
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(1);
    expect(report.invalidReferences).toBe(4);
  });

  it("跨布局不构成重复：不同 canonical 引用（sessions 根 vs projects 根）各自计数", async () => {
    const dataDir = dataDirFixture();
    const references = [
      ref("d1", path.join(dataDir, "sessions", "d1", "x_d1.jsonl")), // default 布局
      ref("d2", path.join(dataDir, "sessions", "d2", "x_d2.jsonl")),
      ref("o1", path.join(dataDir, "projects", OTHER_PROJECT, "sessions", "o1", "x_o1.jsonl"), OTHER_PROJECT),
      ref("o2", path.join(dataDir, "projects", OTHER_PROJECT, "sessions", "o2", "x_o2.jsonl"), OTHER_PROJECT),
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    expect(report.valid).toBe(4);
    expect(report.duplicateReferences).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("DATA_DIR 尾随分隔符与规范化：字面绑定对尾随 / 与引用路径一致", async () => {
    const dataDir = dataDirFixture();
    // 带尾随 / 的 DATA_DIR 与不带尾随 / 的引用仍应绑定成功；引用自身带尾随 / 则非法。
    const report = await analyzeReconcileReferences(
      `${dataDir}/`,
      [ref("s1", path.join(dataDir, "sessions", "s1", "x_s1.jsonl")), ref("s2", path.join(dataDir, "sessions", "s2", "x_s2.jsonl") + "/")],
    );
    expect(report.valid).toBe(1);
    expect(report.invalidReferences).toBe(1);
  });

  it("稳定去重：同一输入两次分析的结果完全一致；引用 hash 稳定且不含路径原文", async () => {
    const dataDir = dataDirFixture();
    const references = [ref("s1", path.join(dataDir, "sessions", "s1", "x_s1.jsonl")), ref("bad", path.join(dataDir, "sessions", "..", "x.jsonl"))];
    const first = await analyzeReconcileReferences(dataDir, references);
    const second = await analyzeReconcileReferences(dataDir, references);
    expect(first).toEqual(second);
    const invalid = first.issues.find((issue) => issue.code === "invalid_reference")!;
    expect(invalid.references[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(invalid.references[0]).not.toContain("sessions");
    expect(invalid.references[0]).not.toContain("..");
  });
});

describe("WP4C DB-only analyzer：报告绝不输出路径/URL/内容", () => {
  it("序列化 JSON 不含 dataDir、分隔符、session id、URL、jsonl 字样或 prompt 内容", async () => {
    const dataDir = dataDirFixture();
    const secretSession = "secret-session-id";
    const promptLike = "system prompt SECRET_PROMPT_MARKER=do-not-leak";
    const references = [
      ref(secretSession, path.join(dataDir, "sessions", secretSession, "x.jsonl")),
      ref("dup-a", path.join(dataDir, "sessions", secretSession, "x.jsonl")), // 重复
      ref("bad", path.join(dataDir, "sessions", "..", "escape.jsonl")), // traversal → invalid
      ref("lazy", null),
    ];
    const report = await analyzeReconcileReferences(dataDir, references);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(promptLike);
    expect(serialized).not.toContain("SECRET_PROMPT_MARKER");
    expect(serialized).not.toContain(dataDir);
    expect(serialized).not.toContain(secretSession);
    expect(serialized).not.toContain("sessions");
    expect(serialized).not.toContain("projects");
    expect(serialized).not.toContain(".jsonl");
    expect(serialized).not.toContain("..");
    expect(serialized.match(/\//g)).toBeNull();
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("http");
    expect(report.executable).toBe(false);
    expect(serialized).not.toContain("outbox");
  });

  it("filesystemNotScanned / cannotDetect 固定字段明确不可探测性；issue codes 固定有限", async () => {
    const dataDir = dataDirFixture();
    const report = await analyzeReconcileReferences(dataDir, [ref("bad", path.join(dataDir, "sessions", "bad", "x.jsonl") + "/..")]);
    expect(report.filesystemNotScanned).toBe(true);
    expect(report.cannotDetect.orphanFile).toBe(false);
    expect(report.cannotDetect.lostFile).toBe(false);
    expect(report.cannotDetect.jsonlValidity).toBe(false);
    for (const issue of report.issues) {
      expect(RECONCILE_ISSUE_CODES).toContain(issue.code);
      expect(issue).toEqual({ code: issue.code, count: issue.count, references: expect.any(Array) });
      for (const reference of issue.references) expect(reference).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(report.issues.map((issue) => issue.code)).toEqual([...report.issues.map((issue) => issue.code)].sort());
  });
});

describe("WP4C DATA_DIR 纯字符串契约（显式、绝对、非 root、无 traversal；不要求存在）", () => {
  it("缺失 / 空白 / 相对 / root / 穿越段：fail-closed 稳定错误且不回显路径", async () => {
    for (const attempt of [undefined, "  ", "relative/data", "/", "/a/../b", "/a/./b", "/a//b"]) {
      expect(() => requireReconcileDataDir(attempt)).toThrow(ReconcileDataDirError);
    }
    // 尾随分隔符是同一目录的字面形式：规范化接受（返回去尾分隔符的规范形式）。
    expect(requireReconcileDataDir("/a/b/")).toBe("/a/b");
    for (const attempt of [path.join(dataDirFixture(), "does-not-exist"), "/a/b/c"]) {
      // 不存在的绝对路径是合法绑定字符串（本分析不触碰文件系统）。
      expect(requireReconcileDataDir(attempt)).toBe(attempt);
    }
    // 错误消息为稳定静态文本，不含任何路径。
    let message = "";
    try {
      requireReconcileDataDir("/a/../b");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("/a");
    expect(message).not.toContain("..");
  });

  it("分析不要求 DATA_DIR 存在：不存在目录的字符串绑定也正常出报告", async () => {
    const dataDir = path.join(dataDirFixture(), "never-created-data-dir");
    const report = await analyzeReconcileReferences(dataDir, [ref("s1", path.join(dataDir, "sessions", "s1", "x_s1.jsonl"))]);
    expect(report.status).toBe("analyzed");
    expect(report.valid).toBe(1);
  });
});