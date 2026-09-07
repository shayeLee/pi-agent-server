// Pi JSONL 会话引用的纯字符串规则。
// 本模块不读取文件、不解析 JSONL、不依赖 Pi SDK，供 reconcile 和 Pi storage 共用。

import path from "node:path";
import { DEFAULT_PROJECT_ID } from "../application/ports/project-store-port.js";
import type { ReconcileReferenceRecord } from "../application/ports/reconcile-reference-port.js";

export type PiJsonlReferenceClassification =
  | { readonly kind: "unmaterialized" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly canonical: string; readonly idsMatch: boolean };

export function requirePiDataDir(raw: string): string {
  const value = raw.trim();
  if (!value || !path.isAbsolute(value) || path.parse(value).root === value) {
    throw new Error("Pi JSONL storage requires a non-root absolute DATA_DIR");
  }
  return path.resolve(value);
}

function splitCleanSegments(value: string): readonly string[] | null {
  if (value.includes("\u0000") || value.startsWith("//") || value.startsWith("\\\\")) return null;
  const root = path.parse(value).root;
  if (root === "") return null;
  const rest = value.slice(root.length);
  if (rest === "") return null;
  const segments = rest.split(path.sep);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments;
}

/** Pi JSONL 的 DB-only 引用形态校验；绝不访问文件系统。 */
export function classifyPiJsonlReference(
  dataDir: string,
  record: ReconcileReferenceRecord,
): PiJsonlReferenceClassification {
  if (record.agentKind !== "pi" || record.conversationFormat !== "pi-jsonl-v3") {
    return { kind: "invalid" };
  }
  const boundDataDir = requirePiDataDir(dataDir);
  const dataRoot = path.parse(boundDataDir).root;
  const dataSegments = boundDataDir.slice(dataRoot.length).split(path.sep);
  const ref = record.conversationRef;
  if (ref === null) return { kind: "unmaterialized" };
  if (ref.trim() === "") return { kind: "invalid" };
  const segments = splitCleanSegments(ref);
  if (segments === null || path.parse(ref).root !== dataRoot || segments.length <= dataSegments.length) return { kind: "invalid" };
  for (let i = 0; i < dataSegments.length; i++) if (segments[i] !== dataSegments[i]) return { kind: "invalid" };
  const layout = segments.slice(dataSegments.length);
  const fileName = layout.at(-1)!;
  if (fileName === "." || fileName === ".." || !fileName.endsWith(".jsonl") || fileName.length <= ".jsonl".length) return { kind: "invalid" };
  if (record.projectId === DEFAULT_PROJECT_ID) {
    if (layout.length !== 3 || layout[0] !== "sessions") return { kind: "invalid" };
    return { kind: "valid", canonical: layout.join("/"), idsMatch: layout[1] === record.sessionId };
  }
  if (layout.length !== 5 || layout[0] !== "projects" || layout[2] !== "sessions") return { kind: "invalid" };
  return {
    kind: "valid",
    canonical: layout.join("/"),
    idsMatch: layout[1] === record.projectId && layout[3] === record.sessionId,
  };
}
