// WP4C（方案 A 收敛）安全 DB-only reconcile analyzer。
//
// 本模块是会话索引与 JSONL 双存储对账的唯一离线实现，边界如下：
// - 数据来源只有一处：受控只读 DB 引用列表（session id/project id/pi_session_file，
//   纯 SELECT，绝不选取 title/system_prompt/cwd 等任何内容字段）；
// - 本实现是纯 DB reference 分析：**绝不触碰文件系统**——不递归遍历、不
//   lstat/open/readFile、不解析任何 JSONL；DATA_DIR 仅作为字符串参与规范布局
//   绑定，不要求存在、不做 realpath/canonical 化、绝不扫描；
// - null 引用 = 懒会话尚未创建（normal unmaterialized），计数但**不是 issue**；
// - 对非 null 引用只做纯字符串/lexical 验证：绝对路径、非 root、位于指定
//   DATA_DIR（字符串形式）下的规范布局，**固定 literal 段逐字校验**——default
//   project → sessions/<sessionId>/<file>（3 段），other project →
//   projects/<projectId>/sessions/<sessionId>/<file>（5 段）；同段数伪目录
//   （如 sessions2/、Projects/、project/、foo/ 等非 literal 段）一律拒绝；
//   同时拒绝 NUL、UNC（// 或 \\ 开头）、traversal、空、错误 DATA_DIR 前缀、
//   parsed root/volume 与 DATA_DIR 不一致（跨卷/伪 root）、id mismatch、非法
//   file name（须为单个非空 stem 的 *.jsonl）；按 canonical reference 分组检测
//   重复引用（owner 优先，与输入/ID 顺序无关）；
// - 因为不扫描文件系统，**不能判定** orphan、lost 或 JSONL 有效性：报告用固定
//   filesystemNotScanned/cannotDetect 字段明确声明，绝不 pretend 能探测；
// - 报告只含 counts、固定 issue codes 与 opaque 引用（sha256 十六进制），
//   绝不包含 relative/absolute 路径、DATA_DIR、URL、session id 或 prompt 内容；
// - executable 恒为 false：本实现永不执行任何处置。真实 filesystem reconcile
//   （orphan/lost/JSONL 损坏探测与处置）留给未来受审计的 native helper。

import { createHash } from "node:crypto";
import path from "node:path";
import { DEFAULT_PROJECT_ID } from "../application/ports/project-store-port.js";
import type { ReconcileReferenceRecord } from "../application/ports/reconcile-reference-port.js";

/** 固定 issue 类别（报告 key 的唯二合法来源；顺序即报告输出顺序）。 */
export const RECONCILE_ISSUE_CODES = [
  "invalid_reference",
  "duplicate_reference",
] as const;

export type ReconcileIssueCode = (typeof RECONCILE_ISSUE_CODES)[number];

export interface ReconcileIssueGroup {
  readonly code: ReconcileIssueCode;
  readonly count: number;
  /** opaque 稳定引用：sha256(session id) 十六进制；绝不含任何路径/URL/内容原文。 */
  readonly references: readonly string[];
}

export interface ReconcileReport {
  readonly status: "analyzed";
  readonly mode: "dry-run";
  /** 恒为 false：本实现永不执行任何处置。 */
  readonly executable: false;
  /** 明确声明：本分析绝不扫描文件系统（无递归遍历/stat/open/readFile/JSONL parse）。 */
  readonly filesystemNotScanned: true;
  /** 不扫描文件系统就无法判定的类别（固定 false 字段，绝不 pretend 能探测）。 */
  readonly cannotDetect: {
    readonly orphanFile: false;
    readonly lostFile: false;
    readonly jsonlValidity: false;
  };
  /** DB 引用行数（受控只读引用列表行数）。 */
  readonly references: number;
  /** pi_session_file 为 null 的会话数（懒会话未创建：normal unmaterialized，非 issue）。 */
  readonly unmaterialized: number;
  /** 词法合法且无重复的规范引用数。 */
  readonly valid: number;
  /** 词法非法引用数（空/相对/root/NUL/UNC/traversal/错误前缀/跨卷/错误布局/id mismatch/非法 file name）。 */
  readonly invalidReferences: number;
  /** canonical reference 重复引用数（同一规范引用被多个会话引用；owner 之外的成员）。 */
  readonly duplicateReferences: number;
  readonly issues: readonly ReconcileIssueGroup[];
}

/** DATA_DIR 契约失败（消息为稳定静态文本，不含任何路径/URL）。 */
export class ReconcileDataDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileDataDirError";
  }
}

/**
 * 路径段切分（纯字符串，不触碰文件系统）：
 * - NUL 字节 / UNC（// 或 \\ 开头）→ null；
 * - 非绝对 / 文件系统 root 自身 / 任何空段（//、尾随 /）或 "." / ".." 段
 *   （traversal）→ null；
 * 其余返回去掉 root 前缀后的段数组。
 */
function splitCleanSegments(value: string): readonly string[] | null {
  if (value.includes("\u0000")) return null; // NUL：任何路径中都不合法
  if (value.startsWith("//") || value.startsWith("\\\\")) return null; // UNC
  const root = path.parse(value).root;
  if (root === "") return null; // 非绝对
  const rest = value.slice(root.length);
  if (rest === "") return null; // 恰好是 root 自身
  const segments = rest.split(path.sep);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments;
}

/**
 * DATA_DIR 纯字符串契约（本分析不触碰文件系统，因此不验证存在性、不做
 * realpath）：显式、绝对、非文件系统 root、无 NUL、非 UNC、路径段无 traversal。
 * 返回字面绝对字符串（去掉 root 前缀与尾部分隔符的规范字面形式），仅用于词法
 * 布局绑定。
 */
export function requireReconcileDataDir(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") throw new ReconcileDataDirError("reconcile-jsonl requires an explicit absolute DATA_DIR");
  if (value.includes("\u0000")) throw new ReconcileDataDirError("reconcile-jsonl DATA_DIR must not contain NUL bytes");
  if (value.startsWith("//") || value.startsWith("\\\\")) {
    throw new ReconcileDataDirError("reconcile-jsonl refuses a UNC DATA_DIR");
  }
  if (!path.isAbsolute(value)) throw new ReconcileDataDirError("reconcile-jsonl requires an absolute DATA_DIR");
  if (path.parse(value).root === value) {
    throw new ReconcileDataDirError("reconcile-jsonl refuses a filesystem-root DATA_DIR");
  }
  // 尾随分隔符是同一目录的字面形式（与引用路径分开处理：引用带尾随分隔符 → 非法）。
  let normalized = value;
  while (normalized.endsWith(path.sep) && normalized.length > path.parse(normalized).root.length) {
    normalized = normalized.slice(0, -1);
  }
  const segments = splitCleanSegments(normalized);
  if (segments === null) {
    // 到达此处只可能是空段 / ./..（相对与 root/NUL/UNC 已在上方拒绝），消息为稳定静态文本。
    throw new ReconcileDataDirError("reconcile-jsonl DATA_DIR must be a clean absolute path");
  }
  return `${path.parse(normalized).root}${segments.join(path.sep)}`;
}

/** opaque 引用：session id 的 sha256，绝不含任何路径/内容原文。 */
function opaqueReference(sessionId: string): string {
  return createHash("sha256").update(`session\u0000${sessionId}`, "utf8").digest("hex");
}

type ReferenceOutcome =
  | { readonly outcome: "unmaterialized" }
  | { readonly outcome: "shapeInvalid" }
  | { readonly outcome: "shapeValid"; readonly canonical: string; readonly idsMatch: boolean };

/**
 * 单个引用的词法分类（纯字符串，绝不触碰文件系统）：
 * - null → unmaterialized（normal，非 issue）；
 * - 非 null：NUL/UNC/空/非绝对/root/parsed root 与 DATA_DIR 不一致（跨卷/伪
 *   root）/不在 DATA_DIR 之下/固定 literal 段不符（同段数伪目录也拒绝，如
 *   sessions2/、Projects/、project/、foo/）/traversal/非法 file name
 *   → shapeInvalid；
 * - 形态合法 → shapeValid：canonical = 规范相对引用（仅用作重复检测，绝不进入
 *   报告），idsMatch = 路径中的 session id/project id 与 DB 行一致（不一致 =
 *   id mismatch）。
 * 重复检测在调用方按 canonical 分组，**owner 优先且与输入/ID 顺序无关**：形态
 * 合法但 id 不匹配的成员不是 owner，见 analyzeReconcileReferences。
 */
function classifyReference(
  dataDirRoot: string,
  dataDirSegments: readonly string[],
  reference: ReconcileReferenceRecord,
): ReferenceOutcome {
  const file = reference.piSessionFile;
  if (file === null) return { outcome: "unmaterialized" };
  if (file.trim() === "") return { outcome: "shapeInvalid" };
  const segments = splitCleanSegments(file);
  if (segments === null) return { outcome: "shapeInvalid" }; // NUL/UNC/非绝对/root 自身/traversal/空段
  // 拒绝跨卷/伪 root：parsed root/volume 必须与 DATA_DIR 完全一致（Windows 上
  // C:\ vs D:\ 在此即被拒绝；posix 上 //、\\ 等形态已在 splitCleanSegments 拒绝）。
  if (path.parse(file).root !== dataDirRoot) return { outcome: "shapeInvalid" };
  // 规范布局绑定：文件必须严格位于 DATA_DIR 之下（段数多且前缀逐字一致）。
  if (segments.length <= dataDirSegments.length) return { outcome: "shapeInvalid" };
  for (let index = 0; index < dataDirSegments.length; index++) {
    if (segments[index] !== dataDirSegments[index]) return { outcome: "shapeInvalid" }; // 错误 DATA_DIR 前缀
  }
  const layout = segments.slice(dataDirSegments.length);
  const fileName = layout[layout.length - 1]!;
  if (fileName === "." || fileName === ".." || !fileName.endsWith(".jsonl") || fileName.length <= ".jsonl".length) {
    return { outcome: "shapeInvalid" }; // 非法 file name（单个 *.jsonl 文件；空 stem 如 ".jsonl" 拒绝）
  }
  const isDefaultProject = reference.projectId === DEFAULT_PROJECT_ID;
  if (isDefaultProject) {
    // 固定段布局：sessions / <sessionId> / <file>；literal 段逐字相等
    // （同段数伪目录 sessionsx/、Projects/ 等一律拒绝）。
    if (layout.length !== 3 || layout[0] !== "sessions") return { outcome: "shapeInvalid" };
    const idsMatch = layout[1] === reference.sessionId;
    return { outcome: "shapeValid", canonical: layout.join("/"), idsMatch };
  }
  // 固定段布局：projects / <projectId> / sessions / <sessionId> / <file>。
  if (layout.length !== 5 || layout[0] !== "projects" || layout[2] !== "sessions") {
    return { outcome: "shapeInvalid" };
  }
  const idsMatch = layout[1] === reference.projectId && layout[3] === reference.sessionId;
  return { outcome: "shapeValid", canonical: layout.join("/"), idsMatch };
}

/**
 * 只读 DB reference 分析：入参为字面绝对 DATA_DIR（纯字符串契约，CLI/调用方
 * 先行校验，此处再防御性校验；不要求存在、不扫描）与受控只读 DB 引用列表。
 * 永不写盘、永不写 DB、永不 enqueue、永不 parse JSONL。
 */
export async function analyzeReconcileReferences(
  dataDir: string,
  references: readonly ReconcileReferenceRecord[],
): Promise<ReconcileReport> {
  const boundDataDir = requireReconcileDataDir(dataDir);
  const dataDirRoot = path.parse(boundDataDir).root;
  const dataDirSegments = boundDataDir.slice(dataDirRoot.length).split(path.sep);
  const outcomes = references.map((reference) => ({
    reference,
    result: classifyReference(dataDirRoot, dataDirSegments, reference),
  }));

  // 同一 sessionId 只分类一次（repository 按 id 升序唯一返回；防御去重）。
  const seenSessions = new Set<string>();
  // canonical（规范相对引用）分组：组内分类与输入顺序/ID 顺序无关。
  const groups = new Map<string, Array<{ sessionId: string; idsMatch: boolean }>>();
  let unmaterialized = 0;
  const invalidReferences = new Set<string>();
  for (const { reference, result } of outcomes) {
    if (seenSessions.has(reference.sessionId)) continue;
    seenSessions.add(reference.sessionId);
    if (result.outcome === "unmaterialized") {
      unmaterialized += 1;
      continue;
    }
    if (result.outcome === "shapeInvalid") {
      invalidReferences.add(reference.sessionId);
      continue;
    }
    const group = groups.get(result.canonical);
    if (group === undefined) {
      groups.set(result.canonical, [{ sessionId: reference.sessionId, idsMatch: result.idsMatch }]);
    } else {
      group.push({ sessionId: reference.sessionId, idsMatch: result.idsMatch });
    }
  }

  // 组内分类（owner 优先，只依赖组内成员集合，与输入/ID 顺序无关）：
  // - 完全匹配 layout 身份（路径中的 session/project id 与 DB 行一致）的成员
  //   是 owner → valid（每 canonical 至多一个）；
  // - 存在 owner 时，组内其余成员一律 duplicate_reference；
  // - 无任何 owner（该 canonical 的所属会话不在 DB 引用中）→ 组内成员一律
  //   invalid_reference（id mismatch），不产生 duplicate。
  let valid = 0;
  const duplicateReferences = new Set<string>();
  for (const group of groups.values()) {
    const owner = group.find((member) => member.idsMatch);
    if (owner === undefined) {
      for (const member of group) invalidReferences.add(member.sessionId);
      continue;
    }
    valid += 1;
    for (const member of group) {
      if (member === owner) continue;
      duplicateReferences.add(member.sessionId); // 重复引用 owner 的 canonical
    }
  }

  const issueSets: Record<ReconcileIssueCode, ReadonlySet<string>> = {
    invalid_reference: new Set([...invalidReferences].map(opaqueReference)),
    duplicate_reference: new Set([...duplicateReferences].map(opaqueReference)),
  };
  const issues: ReconcileIssueGroup[] = [];
  for (const code of RECONCILE_ISSUE_CODES) {
    const set = issueSets[code];
    if (set.size === 0) continue;
    issues.push({ code, count: set.size, references: [...set].sort() });
  }

  return {
    status: "analyzed",
    mode: "dry-run",
    executable: false,
    filesystemNotScanned: true,
    cannotDetect: { orphanFile: false, lostFile: false, jsonlValidity: false },
    references: references.length,
    unmaterialized,
    valid,
    invalidReferences: invalidReferences.size,
    duplicateReferences: duplicateReferences.size,
    issues,
  };
}